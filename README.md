# virtualcode

> **Published on npm as [`virtualcode`](https://www.npmjs.com/package/virtualcode)** ·
> [GitHub](https://github.com/ShaikhWarsi/VirtualCode)

```
        _      _               _               _
 __   _(_)_ __| |_ _   _  __ _| | ___ ___   __| | ___
 \ \ / / | '__| __| | | |/ _` | |/ __/ _ \ / _` |/ _ \
  \ V /| | |  | |_| |_| | (_| | | (_| (_) | (_| |  __/
   \_/ |_|_|   \__|\__,_|\__,_|_|\___\___/ \__,_|\___|

    Talk to your terminal from your phone.
```

A plugin for **OpenCode** and **Kilo Code** that bridges your terminal with Telegram.
Send prompts from your phone, get AI responses back. The AI can also message you via a built-in tool.

---

## Setup

```
npm install -g virtualcode
```

Then you need **two** things in your config — the plugin itself and the TUI plugin so `/telegram` shows in Ctrl+P:

### OpenCode

**`~/.config/opencode/opencode.jsonc`:**
```json
{ "plugin": ["virtualcode"] }
```

**`~/.config/opencode/tui.json`:**
```json
{ "plugin": ["virtualcode/tui"] }
```

### Kilo Code

**`~/.config/kilo/kilo.jsonc`:**
```json
{ "plugin": ["virtualcode"] }
```

**`~/.config/kilo/tui.json`:**
```json
{ "plugin": ["virtualcode/tui"] }
```

---

## Getting a bot token

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`, pick a name and username
3. Copy the token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

---

## Connecting

1. Run `opencode` or `kilo` in your project
2. Type **`/telegram <token>`** in the chat (or Ctrl+P → `/telegram` → paste token)
3. On your phone, open Telegram, find your bot, send `/ls` to see sessions
4. Send `/link <shortID>` (e.g. `/link a1b2c`) to bind the chat to a session

Now any message you send in that Telegram chat goes straight to the AI. Responses come back automatically.

---

## Commands

### In Telegram (talk to your bot)

| Command | What it does |
|---------|-------------|
| `/ls` | List sessions |
| `/link <ID>` | Bind this chat to a session |
| `/unlink` | Unbind |
| `/use <N\|ID>` | Switch session (by number or ID) |
| `/status` | Connection state |
| `/model` | Show/set model override |
| `/models` | List available models |
| `/session` | Session details |
| `/rename <title>` | Rename session |
| `/history [N]` | Last N messages |
| `/agents` | List agents |
| `/help` | All commands |

Anything that isn't a command gets sent as a prompt.

### In the TUI (`/` commands)

| Command | What it does |
|---------|-------------|
| `/telegram` | Open token setup dialog (Ctrl+P) |
| `/telegram <token>` | Connect with a token |
| `/telegram status` | Check if connected |
| `/telegram disconnect` | Stop bot + remove token |

---

## Config options

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["virtualcode", {
      "token": "123456789:ABC...",
      "allowed_users": [12345678],
      "notify_on_reconnect": true
    }]
  ]
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `token` | string | `env.TELEGRAM_BOT_TOKEN` | Bot token |
| `allowed_users` | number[] | all users | Restrict to specific Telegram user IDs |
| `notify_on_reconnect` | boolean | false | Ping chats when bot reconnects |

**Env vars:** `TELEGRAM_BOT_TOKEN` (alternative to config), `DEBUG_TELEGRAM=1` (verbose logs).

---

## LLM tool

The AI can use `telegram_send` to message you back. Ask it to "notify me on Telegram when done" and it will.

---

## Troubleshooting

**Bot not responding** → `/status` to check link, `/ls` then `/link` if not linked.

**`/telegram` not in Ctrl+P** → Make sure `virtualcode/tui` is in your `tui.json` (not `kilo.jsonc`/`opencode.jsonc` — those are for the server plugin).

**Invalid token** → Copy the full token from @BotFather, format is `1234567890:ABCdef...`.

**"Another instance running"** → Only one thing can use a token at once. Wait 30s or stop the other instance.

**Slow responses** → Auto-reconnect backs off: 5s → 10s → 20s → 30s.

---

## How it works

- You text the bot → bot calls `session.prompt()` on your laptop
- AI finishes → plugin detects `idle` status → fetches last message → edits the "..." reply in-place
- No orphaned messages, no polling
- Token, session links, and model overrides saved atomically in `~/.config/opencode/` (or `~/.config/kilo/`)

---

## License

MIT
