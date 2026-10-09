const {
  default: makeWASocket,
  Browsers,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestWaWebVersion,
  getBinaryNodeChildren,
  isHostedLidUser,
  isHostedPnUser,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  toNumber,
  useMultiFileAuthState,
  WAMessageStatus
} = require('@whiskeysockets/baileys')

const fs = require('fs')
const path = require('path')
const readline = require('node:readline/promises')
const P = require('pino')
const qrcode = require('qrcode-terminal')

const AUTH_DIR = path.join(__dirname, 'auth')
const DIAGNOSTIC_LOG = path.join(__dirname, 'diagnostic.log')
const MAX_MEDIA_BYTES = 50 * 1024 * 1024
const MAX_RECOVERIES_PER_MINUTE = 5
const MAX_REMEMBERED_MESSAGE_IDS = 1000
const MAX_CACHED_VIEW_ONCE_MESSAGES = 1000
const MAX_APPEND_AGE_SECONDS = 120
const MAX_PRE_OPEN_HANDSHAKE_RETRIES = 3
const WA_VERSION_FETCH_TIMEOUT_MS = 10_000
const USE_PHONE_PAIRING = process.env.PAIRING_METHOD?.trim().toLowerCase() === 'phone'

const MEDIA_TYPES = {
  imageMessage: { downloadType: 'image', sendType: 'image', mimePrefix: 'image/' },
  videoMessage: { downloadType: 'video', sendType: 'video', mimePrefix: 'video/' },
  audioMessage: { downloadType: 'audio', sendType: 'audio', mimePrefix: 'audio/' }
}

const VIEW_RECEIPT_TYPES = new Set([
  'read',
  'read-self',
  'played',
  'played-self',
  'view_once_read'
])

const TERMINAL_DISCONNECT_REASONS = new Set([
  DisconnectReason.badSession,
  DisconnectReason.forbidden,
  DisconnectReason.loggedOut,
  DisconnectReason.multideviceMismatch
])

const recentMessageIds = new Set()
const cachedViewOnceMessages = new Map()
const recoveredViewedMessageIds = new Set()
const recoveryTimes = []

let activeSocket
let reconnectTimer
let processing = false
let shuttingDown = false
let connectedAtSeconds = 0
let preOpenHandshakeRetries = 0
let qrSeenSinceLastOpen = false

if (process.platform !== 'win32') {
  process.umask(0o077)
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)

  try {
    fs.appendFileSync(DIAGNOSTIC_LOG, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Terminal output remains available if the diagnostic file cannot be written.
  }
}

function normalizePairingPhoneNumber(value) {
  const phoneNumber = String(value ?? '').trim()

  if (!/^\d{7,15}$/.test(phoneNumber)) {
    throw new Error('Phone number must contain only 7 to 15 digits, including the country code')
  }

  return phoneNumber
}

function formatPairingCode(value) {
  return String(value).match(/.{1,4}/g)?.join('-') || String(value)
}

async function promptForPairingPhoneNumber() {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  try {
    const answer = await terminal.question(
      'Enter your WhatsApp number with country code, digits only (example: 201234567890): '
    )
    return normalizePairingPhoneNumber(answer)
  } finally {
    terminal.close()
  }
}

function shouldRequestPhonePairing({ enabled, registered, qr, requested }) {
  return Boolean(enabled && !registered && qr && !requested)
}

async function requestPhonePairing(sock, phoneNumber) {
  const code = await sock.requestPairingCode(phoneNumber)

  log('Generated a phone-number pairing code')
  console.log(`Pairing code: ${formatPairingCode(code)}`)
  console.log('In WhatsApp, open Linked Devices > Link a Device > Link with phone number instead.')
}

function getDisconnectReasonName(statusCode) {
  return DisconnectReason[statusCode] || 'unknown'
}

function getDisconnectMessage(lastDisconnect) {
  const statusCode = lastDisconnect?.error?.output?.statusCode
  const reasonName = getDisconnectReasonName(statusCode)
  const errorMessage = lastDisconnect?.error?.message
  const detail = statusCode ? `${reasonName} (${statusCode})` : reasonName

  return errorMessage ? `${detail}: ${errorMessage}` : detail
}

function isDirectUserJid(jid) {
  const normalizedJid = jidNormalizedUser(jid)

  return Boolean(
    normalizedJid &&
    (
      isPnUser(normalizedJid) ||
      isLidUser(normalizedJid) ||
      isHostedPnUser(normalizedJid) ||
      isHostedLidUser(normalizedJid)
    )
  )
}

function isWithheldViewOnceMessage(message) {
  return Boolean(message?.key?.isViewOnce && !message.message)
}

function isPreOpenHandshakeFailure(statusCode) {
  return statusCode === 405 || statusCode === DisconnectReason.connectionClosed
}

async function getWhatsAppWebVersion(fetchVersion = fetchLatestWaWebVersion) {
  const result = await fetchVersion({
    signal: AbortSignal.timeout(WA_VERSION_FETCH_TIMEOUT_MS)
  })

  if (!Array.isArray(result.version) || result.version.length !== 3) {
    throw new Error('Baileys returned an invalid WhatsApp Web version')
  }

  return result
}

function unwrapViewOnce(content) {
  let current = content
  let foundViewOnce = false

  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current.viewOnceMessage?.message) {
      foundViewOnce = true
      current = current.viewOnceMessage.message
    } else if (current.viewOnceMessageV2?.message) {
      foundViewOnce = true
      current = current.viewOnceMessageV2.message
    } else if (current.viewOnceMessageV2Extension?.message) {
      foundViewOnce = true
      current = current.viewOnceMessageV2Extension.message
    } else if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message
    } else {
      break
    }
  }

  if (foundViewOnce) return current

  for (const messageType of Object.keys(MEDIA_TYPES)) {
    if (current?.[messageType]?.viewOnce === true) {
      return current
    }
  }

  return null
}

function getMessageShape(content) {
  if (!content || typeof content !== 'object') return 'none'

  const wrappers = [
    'deviceSentMessage',
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'editedMessage',
    'associatedChildMessage'
  ]

  const shape = []
  let current = content

  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const key = Object.keys(current).find(name => (
      wrappers.includes(name) ||
      (name.endsWith('Message') && name !== 'senderKeyDistributionMessage')
    ))

    if (!key) break
    shape.push(key)

    if (!wrappers.includes(key) || !current[key]?.message) break
    current = current[key].message
  }

  return shape.join('>') || 'no-user-content'
}

function getQuotedViewOnce(content) {
  const normalized = normalizeMessageContent(content)
  if (!normalized || typeof normalized !== 'object') return null

  for (const value of Object.values(normalized)) {
    const quoted = value?.contextInfo?.quotedMessage
    if (quoted && unwrapViewOnce(quoted)) return quoted
  }

  return null
}

function getQuotedMessageId(content) {
  const normalized = normalizeMessageContent(content)
  if (!normalized || typeof normalized !== 'object') return null

  for (const value of Object.values(normalized)) {
    const stanzaId = value?.contextInfo?.stanzaId
    if (stanzaId) return stanzaId
  }

  return null
}

function getMessageCacheKey(remoteJid, messageId) {
  const normalizedJid = jidNormalizedUser(remoteJid)
  return normalizedJid && messageId ? `${normalizedJid}:${messageId}` : null
}

function cacheViewOnceMessage(message) {
  const remoteJid = message.key?.remoteJid
  const cacheKeys = [
    getMessageCacheKey(remoteJid, message.key?.id),
    getMessageCacheKey(message.key?.remoteJidAlt, message.key?.id)
  ].filter(Boolean)

  if (
    cacheKeys.length === 0 ||
    message.key?.fromMe ||
    !isDirectUserJid(remoteJid) ||
    !unwrapViewOnce(message.message)
  ) {
    return false
  }

  for (const cacheKey of new Set(cacheKeys)) {
    cachedViewOnceMessages.set(cacheKey, message)
  }

  while (cachedViewOnceMessages.size > MAX_CACHED_VIEW_ONCE_MESSAGES) {
    cachedViewOnceMessages.delete(cachedViewOnceMessages.keys().next().value)
  }

  return true
}

function getCachedViewOnceByMessageKey(key) {
  const cacheKeys = [
    getMessageCacheKey(key?.remoteJid, key?.id),
    getMessageCacheKey(key?.remoteJidAlt, key?.id)
  ].filter(Boolean)
  const cacheKey = cacheKeys.find(candidate => cachedViewOnceMessages.has(candidate))
  const cached = cacheKey ? cachedViewOnceMessages.get(cacheKey) : null

  return cached && unwrapViewOnce(cached.message)
    ? { cacheKey, message: cached.message }
    : null
}

function getCachedQuotedViewOnce(message) {
  const quotedMessageId = getQuotedMessageId(message.message)
  const cacheKeys = [
    getMessageCacheKey(message.key?.remoteJid, quotedMessageId),
    getMessageCacheKey(message.key?.remoteJidAlt, quotedMessageId)
  ].filter(Boolean)
  const cached = cacheKeys
    .map(cacheKey => cachedViewOnceMessages.get(cacheKey))
    .find(Boolean)

  return cached && unwrapViewOnce(cached.message) ? cached.message : null
}

function isViewOnceViewedUpdate(messageUpdate) {
  if (!messageUpdate?.key?.id || messageUpdate.key.fromMe) return false
  if (!isDirectUserJid(messageUpdate.key.remoteJid)) return false

  const status = messageUpdate.update?.status
  return status === WAMessageStatus.READ || status === WAMessageStatus.PLAYED
}

function getViewedReceiptMessageKeys(receiptNode) {
  const attrs = receiptNode?.attrs
  if (!attrs?.id || !VIEW_RECEIPT_TYPES.has(attrs.type)) return []

  const ids = [attrs.id]
  if (Array.isArray(receiptNode.content)) {
    for (const child of receiptNode.content) {
      for (const item of getBinaryNodeChildren(child, 'item')) {
        if (item.attrs?.id) ids.push(item.attrs.id)
      }
    }
  }

  const remoteJids = [attrs.from, attrs.recipient]
    .filter((jid, index, values) => jid && values.indexOf(jid) === index)
    .filter(isDirectUserJid)

  return [...new Set(ids)].flatMap(id => (
    remoteJids.map(remoteJid => ({ remoteJid, id, fromMe: false }))
  ))
}

function getSupportedMedia(content) {
  for (const [messageType, config] of Object.entries(MEDIA_TYPES)) {
    const media = content?.[messageType]
    if (!media) continue

    if (!media.mediaKey || (!media.directPath && !media.url)) {
      throw new Error('Media is missing required download information')
    }

    if (!media.mimetype?.startsWith(config.mimePrefix)) {
      throw new Error(`Rejected unexpected ${messageType} MIME type`)
    }

    return { media, ...config }
  }

  return null
}

function getDeclaredFileSize(fileLength) {
  if (fileLength === undefined || fileLength === null) return null

  const size = Number(fileLength.toString())
  return Number.isSafeInteger(size) && size >= 0 ? size : null
}

function assertSafeMediaLocation(media) {
  if (media.directPath) {
    if (typeof media.directPath !== 'string' || !media.directPath.startsWith('/')) {
      throw new Error('Rejected invalid WhatsApp media path')
    }
    return
  }

  const url = new URL(media.url)
  const isWhatsAppHost =
    url.hostname === 'whatsapp.net' || url.hostname.endsWith('.whatsapp.net')

  if (url.protocol !== 'https:' || !isWhatsAppHost) {
    throw new Error('Rejected non-WhatsApp media URL')
  }
}

async function streamToLimitedBuffer(stream, maxBytes = MAX_MEDIA_BYTES) {
  const chunks = []
  let totalBytes = 0

  for await (const chunk of stream) {
    totalBytes += chunk.length

    if (totalBytes > maxBytes) {
      stream.destroy()
      throw new Error(`Media exceeds the ${maxBytes} byte limit`)
    }

    chunks.push(chunk)
  }

  return Buffer.concat(chunks, totalBytes)
}

function rememberMessage(id) {
  if (!id || recentMessageIds.has(id)) return false

  recentMessageIds.add(id)
  if (recentMessageIds.size > MAX_REMEMBERED_MESSAGE_IDS) {
    recentMessageIds.delete(recentMessageIds.values().next().value)
  }

  return true
}

function rememberViewedRecovery(cacheKey) {
  if (!cacheKey || recoveredViewedMessageIds.has(cacheKey)) return false

  recoveredViewedMessageIds.add(cacheKey)
  if (recoveredViewedMessageIds.size > MAX_REMEMBERED_MESSAGE_IDS) {
    recoveredViewedMessageIds.delete(recoveredViewedMessageIds.values().next().value)
  }

  return true
}

function consumeRateLimit() {
  const cutoff = Date.now() - 60_000

  while (recoveryTimes.length && recoveryTimes[0] < cutoff) {
    recoveryTimes.shift()
  }

  if (recoveryTimes.length >= MAX_RECOVERIES_PER_MINUTE) return false

  recoveryTimes.push(Date.now())
  return true
}

function isLiveMessageEvent(type, message) {
  if (type === 'notify') return true
  if (type !== 'append' || !connectedAtSeconds) return false

  const timestamp = toNumber(message.messageTimestamp)
  const now = Math.floor(Date.now() / 1000)

  return (
    timestamp > 0 &&
    timestamp >= connectedAtSeconds - 10 &&
    now - timestamp <= MAX_APPEND_AGE_SECONDS
  )
}

async function secureAuthDirectory() {
  if (process.platform === 'win32') return

  await fs.promises.chmod(AUTH_DIR, 0o700)
  const entries = await fs.promises.readdir(AUTH_DIR, { withFileTypes: true })

  await Promise.all(
    entries
      .filter(entry => entry.isFile())
      .map(entry => fs.promises.chmod(path.join(AUTH_DIR, entry.name), 0o600))
  )
}

async function sendRecoveredMedia(sock, destination, mediaInfo, buffer) {
  const { media, sendType } = mediaInfo

  if (sendType === 'image') {
    await sock.sendMessage(destination, {
      image: buffer,
      mimetype: media.mimetype,
      caption: 'Recovered view-once media'
    })
    return
  }

  if (sendType === 'video') {
    await sock.sendMessage(destination, {
      video: buffer,
      mimetype: media.mimetype,
      caption: 'Recovered view-once media'
    })
    return
  }

  await sock.sendMessage(destination, {
    audio: buffer,
    mimetype: media.mimetype,
    ptt: Boolean(media.ptt)
  })
}

async function recoverViewOnce(sock, message) {
  if (processing) {
    log('Ignored view-once media while another recovery is running')
    return false
  }

  processing = true

  try {
    const content = unwrapViewOnce(message.message)
    if (!content) return false

    const mediaInfo = getSupportedMedia(content)
    if (!mediaInfo) {
      log('Ignored unsupported view-once media type')
      return false
    }

    const declaredSize = getDeclaredFileSize(mediaInfo.media.fileLength)
    if (declaredSize === null) {
      throw new Error('Rejected media without a valid declared size')
    }
    if (declaredSize > MAX_MEDIA_BYTES) {
      throw new Error(`Rejected media larger than ${MAX_MEDIA_BYTES / 1024 / 1024} MB`)
    }

    assertSafeMediaLocation(mediaInfo.media)

    if (!consumeRateLimit()) {
      log('Recovery rate limit reached; ignored view-once media')
      return false
    }

    const destination = jidNormalizedUser(sock.user?.phoneNumber || sock.user?.id)
    if (!isDirectUserJid(destination)) {
      throw new Error('Could not determine the authenticated account destination')
    }

    log('Recovering incoming view-once media')
    const stream = await downloadContentFromMessage(
      mediaInfo.media,
      mediaInfo.downloadType,
      { host: 'mmg.whatsapp.net' }
    )
    const buffer = await streamToLimitedBuffer(stream)

    await sendRecoveredMedia(sock, destination, mediaInfo, buffer)
    log('Recovered media sent to the authenticated account')
    return true
  } catch (error) {
    log(`Recovery failed: ${error.message}`)
    return false
  } finally {
    processing = false
  }
}

async function recoverQuotedViewOnce(sock, message) {
  const quoted = getQuotedViewOnce(message.message) || getCachedQuotedViewOnce(message)
  if (!quoted) {
    if (getQuotedMessageId(message.message)) {
      log('Owner reply did not include recoverable view-once media metadata')
    }
    return false
  }

  log('Detected owner reply to view-once media')
  await recoverViewOnce(sock, { ...message, message: quoted })
  return true
}

async function recoverViewedViewOnce(sock, messageUpdate) {
  if (!isViewOnceViewedUpdate(messageUpdate)) return false

  const cached = getCachedViewOnceByMessageKey(messageUpdate.key)
  if (!cached || recoveredViewedMessageIds.has(cached.cacheKey)) return false

  log('Detected owner view of cached view-once media')
  const recovered = await recoverViewOnce(sock, {
    key: messageUpdate.key,
    message: cached.message
  })

  if (recovered) rememberViewedRecovery(cached.cacheKey)
  return recovered
}

async function recoverViewedReceipt(sock, receiptNode) {
  let recoveredAny = false

  for (const key of getViewedReceiptMessageKeys(receiptNode)) {
    const recovered = await recoverViewedViewOnce(sock, {
      key,
      update: { status: WAMessageStatus.READ }
    })
    recoveredAny = recovered || recoveredAny
  }

  return recoveredAny
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    startBot().catch(error => {
      log(`Startup failed: ${error.message}`)
      scheduleReconnect()
    })
  }, 5_000)
}

async function startBot() {
  log('Starting safe view-once recovery bot')

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  await secureAuthDirectory()

  const pairingPhoneNumber = USE_PHONE_PAIRING && !state.creds.registered
    ? await promptForPairingPhoneNumber()
    : undefined
  let pairingCodeRequested = false

  const versionResult = await getWhatsAppWebVersion()
  const version = versionResult.version
  if (versionResult.isLatest) {
    log(`Using current WhatsApp Web version ${version.join('.')}`)
  } else {
    log(`Could not fetch the current WhatsApp Web version; using bundled version ${version.join('.')}`)
  }

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS('Chrome'),
    emitOwnEvents: false,
    logger: P({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    version
  })

  activeSocket = sock

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds()
      await secureAuthDirectory()
    } catch (error) {
      log(`Could not save credentials: ${error.message}`)
    }
  })

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      qrSeenSinceLastOpen = true
      preOpenHandshakeRetries = 0

      if (shouldRequestPhonePairing({
        enabled: USE_PHONE_PAIRING,
        registered: state.creds.registered,
        qr,
        requested: pairingCodeRequested
      })) {
        pairingCodeRequested = true
        void requestPhonePairing(sock, pairingPhoneNumber).catch(error => {
          log(`Phone-number pairing failed: ${error.message}`)
        })
      } else if (!USE_PHONE_PAIRING) {
        log('Scan this QR only from your own WhatsApp Linked Devices screen')
        qrcode.generate(qr, { small: true })
      }
    }

    if (connection === 'open') {
      connectedAtSeconds = Math.floor(Date.now() / 1000)
      preOpenHandshakeRetries = 0
      qrSeenSinceLastOpen = false
      log('Connected')
    }

    if (connection === 'close' && activeSocket === sock) {
      const hadConnected = connectedAtSeconds > 0
      const hadQr = qrSeenSinceLastOpen
      qrSeenSinceLastOpen = false
      connectedAtSeconds = 0
      const statusCode = lastDisconnect?.error?.output?.statusCode
      activeSocket = undefined

      log(`Connection closed: ${getDisconnectMessage(lastDisconnect)}`)

      if (TERMINAL_DISCONNECT_REASONS.has(statusCode)) {
        log('Session cannot reconnect automatically; delete auth/ and pair again')
      } else if (
        isPreOpenHandshakeFailure(statusCode) &&
        !hadConnected &&
        !hadQr &&
        ++preOpenHandshakeRetries >= MAX_PRE_OPEN_HANDSHAKE_RETRIES
      ) {
        if (statusCode === 405) {
          log('WhatsApp rejected the client handshake repeatedly')
          log('Check access to web.whatsapp.com and update Baileys before trying again')
        } else {
          log('WhatsApp terminated the session before it could open repeatedly')
          log('The saved auth session is likely stale; move or delete auth/ and run npm start to pair again')
        }
      } else {
        log('Reconnecting shortly')
        scheduleReconnect()
      }
    }
  })

  sock.ev.on('messaging-history.set', ({ messages }) => {
    let cachedCount = 0

    for (const message of messages) {
      if (cacheViewOnceMessage(message)) cachedCount += 1
    }

    if (cachedCount > 0) {
      log(`Cached ${cachedCount} old private view-once message(s) for reply recovery`)
    }
  })

  sock.ev.on('messages.update', updates => {
    for (const messageUpdate of updates) {
      void recoverViewedViewOnce(sock, messageUpdate).catch(error => {
        log(`Owner view recovery failed: ${error.message}`)
      })
    }
  })

  sock.ws.on('CB:receipt', receiptNode => {
    void recoverViewedReceipt(sock, receiptNode).catch(error => {
      log(`Owner view receipt recovery failed: ${error.message}`)
    })
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    log(`Received message event (${type}, ${messages.length} item(s))`)

    for (const message of messages) {
      const remoteJid = message.key?.remoteJid
      const shape = getMessageShape(message.message)

      if (!message.message) {
        if (isWithheldViewOnceMessage(message)) {
          log('Detected view-once media, but WhatsApp withheld it from this linked device')
          log('Reply to the unopened view-once message from the linked account to attempt recovery')
        } else {
          log('Ignored message without decryptable content')
        }
        continue
      }

      if (message.key.fromMe) {
        if (isDirectUserJid(remoteJid)) {
          void awaitOwnerRecovery(sock, message)
          continue
        }

        log(`Ignored message sent by the authenticated account (${shape})`)
        continue
      }

      const cachedForReply = cacheViewOnceMessage(message)

      if (!isLiveMessageEvent(type, message)) {
        if (cachedForReply) {
          log('Cached old private view-once message for reply recovery')
        } else {
          log(`Ignored old or unsupported message event (${shape})`)
        }
        continue
      }

      if (!rememberMessage(message.key.id)) {
        log(`Ignored duplicate message event (${shape})`)
        continue
      }

      if (!isDirectUserJid(remoteJid)) {
        log(`Ignored incoming non-private message (${shape})`)
        continue
      }

      if (!unwrapViewOnce(message.message)) {
        log(`Received private message; it was not usable view-once media (${shape})`)
        continue
      }

      log('Detected incoming private view-once media')
      void recoverViewOnce(sock, message)
    }
  })
}

function awaitOwnerRecovery(sock, message) {
  return recoverQuotedViewOnce(sock, message).catch(error => {
    log(`Owner reply recovery failed: ${error.message}`)
    return false
  })
}

function shutdown() {
  shuttingDown = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  activeSocket?.end(new Error('Process shutting down'))
}

if (require.main === module) {
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  startBot().catch(error => {
    log(`Startup failed: ${error.message}`)
    scheduleReconnect()
  })
}

module.exports = {
  assertSafeMediaLocation,
  getDeclaredFileSize,
  getMessageShape,
  getQuotedMessageId,
  getQuotedViewOnce,
  getSupportedMedia,
  getWhatsAppWebVersion,
  getViewedReceiptMessageKeys,
  isDirectUserJid,
  isLiveMessageEvent,
  isPreOpenHandshakeFailure,
  isWithheldViewOnceMessage,
  isViewOnceViewedUpdate,
  normalizePairingPhoneNumber,
  shouldRequestPhonePairing,
  streamToLimitedBuffer,
  unwrapViewOnce
}
