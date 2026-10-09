# Run the bot on an Android phone with Termux

This method is free and does not require a cloud account. The phone must remain
powered on and connected to the internet. Android may stop Termux unless its
battery optimization is disabled.

## 1. Prepare Termux

Open Android **Settings > Apps > Termux > Battery** and allow unrestricted
background usage or disable battery optimization for Termux.

Then run these commands in Termux:

```sh
pkg update
pkg upgrade
pkg install git gh nodejs-lts npm tmux
```

Check that Node.js is version 20 or newer:

```sh
node --version
```

## 2. Download the bot

```sh
cd ~
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
gh repo clone a7madxx/wa-bot-mine
cd wa-bot-mine
npm ci
```

The GitHub login uses a one-time browser code. Never enter a GitHub password or
personal access token into a command that would save it in shell history.

## 3. Pair WhatsApp on the same phone

Start a persistent terminal session:

```sh
termux-wake-lock
cd ~/wa-bot-mine
tmux new -s wa-bot
PAIRING_METHOD=phone npm start
```

Enter the WhatsApp number when prompted. Use digits only and include the
country code; do not include `+`, spaces, parentheses, or hyphens. For example,
an Egyptian number beginning `012...` becomes `2012...`.

The bot prints an eight-character pairing code. Switch to WhatsApp and open:

**Settings > Linked Devices > Link a Device > Link with phone number instead**

Enter the code. Return to Termux and wait for `Connected`.

The bot collects the number before connecting, then waits until WhatsApp says
the socket is ready before requesting one pairing code. Do not pipe the phone
number into `npm start`.

The phone number and pairing code are not written to `diagnostic.log`. Never
share the pairing code with anyone.

## 4. Leave it running

Detach from the terminal without stopping the bot by pressing `Ctrl+B`, then
`D`. You can now close the Termux window, but do not force-stop the app.

To see the bot again:

```sh
tmux attach -t wa-bot
```

## Start and stop from the phone

To stop the bot, attach to it and press `Ctrl+C`:

```sh
tmux attach -t wa-bot
```

Then release the wake lock:

```sh
termux-wake-unlock
```

To start it later, run:

```sh
termux-wake-lock
cd ~/wa-bot-mine
tmux new -s wa-bot
npm start
```

After the first successful pairing, `PAIRING_METHOD=phone` is no longer needed.
The saved session stays in `~/wa-bot-mine/auth/`.

## Recover from an incomplete pairing attempt

Stop the bot with `Ctrl+C`, update it, and move the incomplete credentials out
of the repository before trying once more:

```sh
cd ~/wa-bot-mine
git pull --ff-only
mv auth ~/wa-bot-auth-incomplete
PAIRING_METHOD=phone npm start
```

If `~/wa-bot-auth-incomplete` already exists, choose another backup name. Once
the new attempt prints `Connected`, keep the new `auth/` directory and use only
`npm start` for later starts.
