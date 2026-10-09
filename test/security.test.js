const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const test = require('node:test')
const { DisconnectReason, WAMessageStatus } = require('@whiskeysockets/baileys')

const {
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
} = require('../index')

test('accepts only an international phone number made of digits', () => {
  assert.equal(normalizePairingPhoneNumber(' 201234567890 '), '201234567890')
  assert.throws(() => normalizePairingPhoneNumber('+201234567890'), /only 7 to 15 digits/)
  assert.throws(() => normalizePairingPhoneNumber('0123-456-789'), /only 7 to 15 digits/)
  assert.throws(() => normalizePairingPhoneNumber('123'), /only 7 to 15 digits/)
})

test('requests phone pairing once only after the socket emits a QR', () => {
  const ready = {
    enabled: true,
    registered: false,
    qr: 'qr-ready',
    requested: false
  }

  assert.equal(shouldRequestPhonePairing(ready), true)
  assert.equal(shouldRequestPhonePairing({ ...ready, qr: undefined }), false)
  assert.equal(shouldRequestPhonePairing({ ...ready, requested: true }), false)
  assert.equal(shouldRequestPhonePairing({ ...ready, registered: true }), false)
  assert.equal(shouldRequestPhonePairing({ ...ready, enabled: false }), false)
})

test('fetches the current WhatsApp Web version for the socket handshake', async () => {
  const expected = [2, 3000, 1234567890]
  let receivedOptions
  const result = await getWhatsAppWebVersion(async options => {
    receivedOptions = options
    return { version: expected, isLatest: true }
  })

  assert.deepEqual(result, { version: expected, isLatest: true })
  assert.equal(receivedOptions.signal instanceof AbortSignal, true)
})

test('recognizes pre-open handshake failures that must not retry forever', () => {
  assert.equal(isPreOpenHandshakeFailure(405), true)
  assert.equal(isPreOpenHandshakeFailure(DisconnectReason.connectionClosed), true)
  assert.equal(isPreOpenHandshakeFailure(500), false)
})

test('recognizes a view-once payload withheld from a linked device', () => {
  assert.equal(
    isWithheldViewOnceMessage({ key: { isViewOnce: true }, message: undefined }),
    true
  )
  assert.equal(
    isWithheldViewOnceMessage({
      key: { isViewOnce: true },
      message: { viewOnceMessageV2: { message: {} } }
    }),
    false
  )
  assert.equal(isWithheldViewOnceMessage({ key: {}, message: undefined }), false)
})

test('accepts direct user JIDs and rejects group or broadcast JIDs', () => {
  assert.equal(isDirectUserJid('201234567890@s.whatsapp.net'), true)
  assert.equal(isDirectUserJid('201234567890@c.us'), true)
  assert.equal(isDirectUserJid('12345@lid'), true)
  assert.equal(isDirectUserJid('12345@g.us'), false)
  assert.equal(isDirectUserJid('status@broadcast'), false)
  assert.equal(isDirectUserJid('12345@newsletter'), false)
})

test('accepts live notifications and rejects unsupported event types', () => {
  assert.equal(isLiveMessageEvent('notify', {}), true)
  assert.equal(isLiveMessageEvent('history', {}), false)
})

test('recognizes owner view updates for incoming private messages only', () => {
  assert.equal(
    isViewOnceViewedUpdate({
      key: { remoteJid: '201234567890@s.whatsapp.net', id: 'A', fromMe: false },
      update: { status: WAMessageStatus.READ }
    }),
    true
  )
  assert.equal(
    isViewOnceViewedUpdate({
      key: { remoteJid: '201234567890@s.whatsapp.net', id: 'A', fromMe: false },
      update: { status: WAMessageStatus.PLAYED }
    }),
    true
  )
  assert.equal(
    isViewOnceViewedUpdate({
      key: { remoteJid: '201234567890@s.whatsapp.net', id: 'A', fromMe: true },
      update: { status: WAMessageStatus.READ }
    }),
    false
  )
  assert.equal(
    isViewOnceViewedUpdate({
      key: { remoteJid: '12345@g.us', id: 'A', fromMe: false },
      update: { status: WAMessageStatus.READ }
    }),
    false
  )
})

test('extracts raw owner view receipt message keys', () => {
  assert.deepEqual(
    getViewedReceiptMessageKeys({
      attrs: {
        from: '201234567890@s.whatsapp.net',
        id: 'VIEWED-1',
        type: 'view_once_read'
      }
    }),
    [{ remoteJid: '201234567890@s.whatsapp.net', id: 'VIEWED-1', fromMe: false }]
  )

  assert.deepEqual(
    getViewedReceiptMessageKeys({
      attrs: {
        from: '201234567890@s.whatsapp.net',
        id: 'VIEWED-1',
        type: 'played-self'
      },
      content: [
        {
          tag: 'list',
          attrs: {},
          content: [{ tag: 'item', attrs: { id: 'VIEWED-2' } }]
        }
      ]
    }).map(key => key.id),
    ['VIEWED-1', 'VIEWED-2']
  )

  assert.deepEqual(
    getViewedReceiptMessageKeys({
      attrs: { from: '201234567890@s.whatsapp.net', id: 'A', type: 'sender' }
    }),
    []
  )
})

test('describes message structure without reading message values', () => {
  assert.equal(
    getMessageShape({
      ephemeralMessage: {
        message: {
          viewOnceMessageV2: {
            message: {
              imageMessage: { caption: 'must not appear in shape' }
            }
          }
        }
      }
    }),
    'ephemeralMessage>viewOnceMessageV2>imageMessage'
  )
})

test('unwraps only messages with a real view-once wrapper', () => {
  const media = {
    imageMessage: {
      directPath: '/mms/image/example',
      fileLength: 10,
      mediaKey: Buffer.alloc(32),
      mimetype: 'image/jpeg'
    }
  }

  assert.equal(unwrapViewOnce(media), null)
  assert.equal(
    unwrapViewOnce({
      ephemeralMessage: {
        message: {
          viewOnceMessageV2: { message: media }
        }
      }
    }),
    media
  )

  assert.equal(
    unwrapViewOnce({
      imageMessage: {
        ...media.imageMessage,
        viewOnce: true
      }
    }).imageMessage.viewOnce,
    true
  )

  assert.equal(
    unwrapViewOnce({
      imageMessage: {
        ...media.imageMessage,
        viewOnce: false
      }
    }),
    null
  )
})

test('extracts a quoted view-once message only from a reply', () => {
  const quoted = {
    viewOnceMessageV2: {
      message: {
        imageMessage: {
          directPath: '/mms/image/example',
          fileLength: 10,
          mediaKey: Buffer.alloc(32),
          mimetype: 'image/jpeg'
        }
      }
    }
  }

  assert.equal(
    getQuotedViewOnce({
      extendedTextMessage: {
        text: 'recover',
        contextInfo: { quotedMessage: quoted }
      }
    }),
    quoted
  )
  assert.equal(getQuotedViewOnce({ extendedTextMessage: { text: 'recover' } }), null)
})

test('extracts the quoted message id used to find synced old media', () => {
  assert.equal(
    getQuotedMessageId({
      extendedTextMessage: {
        text: 'recover',
        contextInfo: { stanzaId: 'OLD-MESSAGE-ID' }
      }
    }),
    'OLD-MESSAGE-ID'
  )
  assert.equal(getQuotedMessageId({ conversation: 'recover' }), null)
})

test('accepts supported media and rejects an unexpected MIME type', () => {
  const image = {
    directPath: '/mms/image/example',
    fileLength: 10,
    mediaKey: Buffer.alloc(32),
    mimetype: 'image/jpeg'
  }

  assert.equal(getSupportedMedia({ imageMessage: image }).downloadType, 'image')
  assert.throws(
    () => getSupportedMedia({ imageMessage: { ...image, mimetype: 'text/html' } }),
    /unexpected/
  )
})

test('restricts direct media URLs to HTTPS WhatsApp hosts', () => {
  assert.doesNotThrow(() => assertSafeMediaLocation({ directPath: '/mms/image/example' }))
  assert.doesNotThrow(() =>
    assertSafeMediaLocation({ url: 'https://mmg.whatsapp.net/mms/image/example' })
  )
  assert.throws(
    () => assertSafeMediaLocation({ url: 'http://mmg.whatsapp.net/mms/image/example' }),
    /non-WhatsApp/
  )
  assert.throws(
    () => assertSafeMediaLocation({ url: 'https://example.com/private-resource' }),
    /non-WhatsApp/
  )
})

test('validates declared sizes and enforces the streaming size limit', async () => {
  assert.equal(getDeclaredFileSize(25), 25)
  assert.equal(getDeclaredFileSize({ toString: () => '25' }), 25)
  assert.equal(getDeclaredFileSize({ toString: () => 'not-a-number' }), null)

  const small = await streamToLimitedBuffer(Readable.from([Buffer.from('abc')]), 3)
  assert.equal(small.toString(), 'abc')

  await assert.rejects(
    streamToLimitedBuffer(Readable.from([Buffer.from('abcd')]), 3),
    /3 byte limit/
  )
})
