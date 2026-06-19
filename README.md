# virtualcode

```
 __     ___                                _
 \ \   / (_)_ __   ___  ___  _ __   ___  | |_
  \ \ / /| | '_ \ / _ \/ _ \| '_ \ / _ \ | __|
   \ V / | | | | |  __/ (_) | | | | (_) || |_
    \_/  |_|_| |_|\___|\___/|_| |_|\___/  \__|

    Talk to your terminal from your phone.
```

An [OpenCode](https://opencode.ai) plugin that bridges your terminal sessions with Telegram.
Send prompts from your phone, receive LLM responses in real time. The LLM can also message
you back via a built-in tool.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  YOUR PHONE                          YOUR TERMINAL              │
│  ┌───────────────────┐               ┌───────────────────┐     │
│  │ Telegram          │               │ $ opencode        │     │
│  │                   │               │                   │     │
│  │ > fix the bug     │ ─────────────>│ [AI] analyzing... │     │
│  │                   │               │                   │     │
│  │ [AI] Fixed. The  │ <─────────────│ [AI] Fixed. The   │     │
│  │ issue was in...   │               │ issue was in...   │     │
│  │                   │               │                   │     │
│  └───────────────────┘               └───────────────────┘     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Installation

```bash
npm install -g virtualcode
```

Then add the plugin to your OpenCode config:

```json
{
  "plugin": ["virtualcode"]
}
```

And to your TUI config (`~/.config/opencode/tui.json`):

```json
{
  "plugin": ["virtualcode"]
}
```

---

## Setup

### 1. Create a Telegram Bot

```
1. Open Telegram and search for @BotFather
2. Send /newbot
3. Choose a name and username for your bot
4. Copy the token (format: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz)
```

### 2. Connect the Bot

In your OpenCode terminal, type `/telegram` and paste your bot token.

Or configure it directly in `opencode.jsonc`:

```json
{
  "plugin": [
    ["virtualcode", {
      "token": "YOUR_BOT_TOKEN",
      "allowed_users": [YOUR_TELEGRAM_USER_ID]
    }]
  ]
}
```

### 3. Link a Session

In your Telegram chat with the bot:

```
/ls          -- list your OpenCode sessions
/link <ID>   -- bind this chat to a session
```

Now any message you send goes to that session. Responses come back automatically.

---

## Commands

### Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and quick setup guide |
| `/link <ID>` | Bind this chat to an OpenCode session |
| `/unlink` | Remove the session binding |
| `/status` | Show connection state and linked session |
| `/ls` | List recent sessions (number, title, ID) |
| `/use <N\|ID>` | Switch to a session by number or ID |
| `/history [N]` | View last N messages in the linked session |
| `/help` | Show command reference |

Any other message is forwarded to the linked session as a prompt.

### OpenCode Terminal Commands

| Command | Description |
|---------|-------------|
| `/telegram` | Open token setup dialog |
| `/telegram <token>` | Connect with a bot token |
| `/telegram status` | Show bot connection state |
| `/telegram disconnect` | Stop bot and remove saved token |

---

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `token` | `string` | `env.TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `allowed_users` | `number[]` | `null` (all) | Restrict access to specific Telegram user IDs |
| `notify_on_reconnect` | `boolean` | `false` | Send a message to linked chats when the bot reconnects |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token (alternative to config) |
| `DEBUG_TELEGRAM` | Set to `1` to enable verbose debug logging |

---

## How It Works

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Telegram Bot                    OpenCode Plugin                     │
│  ┌──────────────┐                ┌──────────────────────────────┐   │
│  │              │   send prompt  │                              │   │
│  │  User sends  │ ─────────────> │  session.prompt()            │   │
│  │  a message   │                │                              │   │
│  │              │                │                              │   │
│  │              │   response     │  session.status -> idle      │   │
│  │  User sees   │ <───────────── │  -> fetch last message       │   │
│  │  AI reply    │                │  -> sendMessage()            │   │
│  │              │                │                              │   │
│  └──────────────┘                └──────────────────────────────┘   │
│                                                                      │
│  Persistence:                                                        │
│  ~/.config/opencode/telegram-token.json    (bot token)               │
│  ~/.config/opencode/telegram-links.json    (chat <-> session map)    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

**Bot doesn't respond to messages**

```
1. Check /status -- is the chat linked to a session?
2. If not linked, use /ls then /link <ID>
3. If linked, check OpenCode logs for errors
```

**"Invalid token" error**

```
1. Make sure you copied the full token from @BotFather
2. Token format: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz
3. Try /telegram disconnect then reconnect with the correct token
```

**"Another bot instance running" error**

```
Only one bot can use a token at a time. Check if:
- Another OpenCode instance is running
- Another app is using the same bot token
- A previous instance didn't shut down cleanly (wait 30s)
```

**Messages not coming back from OpenCode**

```
1. Check that the session is still active in OpenCode
2. The bot auto-reconnects after failures (5s -> 10s -> 20s -> 30s)
3. Set DEBUG_TELEGRAM=1 to see detailed logs
```

**Session ID not found**

```
1. Use /ls to list sessions
2. Copy the full ID (starts with "ses_")
3. You can also use the number: /use 1
4. Prefix matching works: /link ses_123 (if unique)
```

---

## Architecture

```
virtualcode
├── src/
│   ├── index.ts      Server plugin (bot logic, session bridge, event handling)
│   └── tui.ts        TUI plugin (slash command, token dialog)
├── install.js        Postinstall script (auto-configures opencode.jsonc + tui.json)
├── package.json      npm: virtualcode
└── dist/             Compiled output
```

**Key design decisions:**

- Atomic file writes (write to .tmp, then rename) prevent corruption
- All errors are sanitized before reaching the UI (no stack traces)
- Exponential backoff auto-reconnect (5s -> 10s -> 20s -> 30s cap)
- LRU-bounded session tracking (max 100 entries)
- Pending message timeout (30s) prevents memory leaks
- Prefix matching for session IDs with ambiguity detection

---

## Contributing

Issues and PRs welcome.

```bash
git clone https://github.com/anomalyco/opencode-telegram.git
cd opencode-telegram
npm install
npm run build
```

---

## License

MIT
