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

A plugin for [OpenCode](https://opencode.ai) and **Kilo Code** that bridges your terminal
sessions with Telegram. Send prompts from your phone, receive LLM responses in real time.
The LLM can also message you back via a built-in tool.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  YOUR PHONE                          YOUR TERMINAL              │
│  ┌───────────────────┐                ┌───────────────────┐     │
│  │ Telegram          │                │ $ opencode        │     │
│  │                   │                │  or $ kilo        │     │
│  │ > fix the bug     │ ──────────────>│ [AI] analyzing... │     │
│  │                   │                │                   │     │
│  │ [AI] Fixed. The   │ <──────────────│ [AI] Fixed. The   │     │
│  │ issue was in...   │                │ issue was in...   │     │
│  │                   │                │                   │     │
│  └───────────────────┘                └───────────────────┘     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Installation

```bash
npm install -g virtualcode
```

The postinstall script automatically detects installed tools and adds the plugin to
their config files.

---

## Setup

### 1. Create a Telegram Bot

Open Telegram, search for [@BotFather](https://t.me/botfather), send `/newbot`, choose
a name and username, then copy the token (format: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyzABCDef` – 8-12 digits, colon, 30-50 alphanumeric/dash chars).

### 2. Connect the Bot

Start **opencode** or **kilo**.

**OpenCode:** Open the command palette (Ctrl+P), type `/telegram` for a popup dialog, or type `/telegram <token>` directly in chat.

**Kilo Code:** Type `/telegram <token>` directly in chat. The `/telegram` command does not appear in Kilo's command palette — just type it in the chat input.

The plugin saves the token automatically.

### 3. Link a Session

In your Telegram chat with the bot:

```
/ls          -- list your sessions (shows short IDs like a1b2c)
/link a1b2c  -- bind this chat to that session
```

Now any message you send goes to that session. Responses come back automatically.

---

## Session IDs

Session IDs use a short format for mobile-friendly use.

```
Full ID:  ses_11c899884ffegeG6H8IQvW1UCR
Display:  11c89...
```

- `/ls` shows abbreviated IDs: `20. What is 2+2? -- 11c89...`
- `/link a1b2c` matches any session whose short ID starts with `a1b2c`
- `/use a1b2c` works the same way
- You can still use the full `ses_...` ID if you have it

---

## Commands

### Telegram Bot Commands

These are sent in your Telegram chat with the bot.

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and quick setup guide |
| `/link <ID>` | Bind this chat to a session (short ID, e.g. `a1b2c`) |
| `/unlink` | Remove the session binding |
| `/status` | Show connection state and linked session |
| `/ls` / `/sessions` | List recent sessions (numbered, with title and short ID) |
| `/use <N\|ID>` | Switch session by number (from `/ls`) or short ID |
| `/model` | Show current model override for the linked session |
| `/model <providerID/modelID>` | Set a model override (e.g. `openai/gpt-4o`) |
| `/model clear` / `off` / `reset` | Clear the model override (use default model) |
| `/models` | List all available models from your configured providers |
| `/session` | Show linked session details (title, ID, timestamps, file summary) |
| `/rename <title>` | Rename the linked session |
| `/agents` | List available agents |
| `/history [N]` | View last N messages (default 20, max 100) |
| `/help` | Show this command reference |

Any other message you send is forwarded to the linked session as a prompt. The AI
response is sent back automatically.

### TUI Terminal Commands

These are typed inside the OpenCode/Kilo Code terminal (TUI).

| Command | Description |
|---------|-------------|
| `/telegram` | Open a token setup dialog where you paste your bot token (**OpenCode only — not available in Kilo's palette**) |
| `/telegram <token>` | Connect with a bot token directly (works in both OpenCode and Kilo Code chat input) |
| `/telegram status` | Show whether the bot is connected |
| `/telegram disconnect` | Stop the bot and remove the saved token |

These commands work with the **server plugin** — they are intercepted before reaching
the LLM, so the bot token never gets sent to your AI provider.

---

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `token` | `string` | `env.TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather (`^\d{8,12}:[\w-]{30,50}$`) |
| `allowed_users` | `number[]` | `null` (all users) | Restrict access to specific Telegram user IDs (integer IDs, e.g. `[12345678]`) |
| `notify_on_reconnect` | `boolean` | `false` | Send "reconnected" message to linked chats on reconnect |

Example with all options:

```json
{
  "plugin": [
    ["virtualcode", {
      "token": "1234567890:ABCdefGHIjklMNOpqrsTUVwxyzABCDef",
      "allowed_users": [12345678],
      "notify_on_reconnect": true
    }]
  ]
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token (alternative to config or `/telegram` command) |
| `DEBUG_TELEGRAM` | Set to `1` to enable verbose debug logging |

---

## LLM Tool: `telegram_send`

The LLM can send messages to your Telegram via a built-in tool. When you're in a linked
session, the AI can notify you of progress, ask questions, or report results.

Example prompt from Telegram:

```
Check the server logs and let me know if there are errors
```

The AI will use the `telegram_send` tool to message you back with its findings.

---

## How It Works

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Telegram Bot                    OpenCode/Kilo Plugin                │
│  ┌──────────────┐                ┌──────────────────────────────┐    │
│  │              │   send prompt  │                              │    │
│  │  User sends  │ ──────────────>│  client.session.prompt()     │    │
│  │  a message   │                │  (async)                     │    │
│  │              │                │                              │    │
│  │              │   response     │  session.status -> idle      │    │
│  │  User sees   │ <──────────────│  -> fetch last message       │    │
│  │  AI reply    │                │  -> editMessage() on ...     │    │
│  │  (edited     │                │                              │    │
│  │   in-place)  │                │                              │    │
│  └──────────────┘                └──────────────────────────────┘    │
│                                                                      │
│  Persistence (tool-independent):                                     │
│  ~/.config/opencode or ~/.config/kilo/                               │
│  ├── telegram-token.json    (bot token, save via /telegram <t>)      │
│  ├── telegram-links.json    (chat <-> session bindings)              │
│  └── telegram-models.json   (per-session model overrides)            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Key design details:**

- The working `...` message is **edited in-place** with the AI response (no orphaned messages)
- Atomic file writes (write to `.tmp`, then rename) prevent corruption
- All errors are sanitized before reaching any UI (no stack traces)
- Exponential backoff auto-reconnect (5s → 10s → 20s → 30s cap)
- LRU-bounded session tracking (max 100 entries)
- Pending message timeout (120s) prevents memory leaks
- Prefix matching for session IDs with ambiguity detection
- Inactive session detection prevents prompts to stale sessions

---

## Troubleshooting

**Plugin not detected after install (or `/telegram` not available)**

```
The postinstall script should auto-configure everything. If `/telegram` isn't
showing up, the plugin files may not have been added to your configs.

Manually add to OpenCode:

  Server (~/.config/opencode/opencode.jsonc):
    { "plugin": ["virtualcode"] }

  TUI (~/.config/opencode/tui.json):
    { "plugin": ["virtualcode/tui"] }

Manually add to Kilo:

  Server (~/.config/kilo/kilo.jsonc):
    { "plugin": ["virtualcode"] }

  TUI (~/.config/kilo/tui.json):
    { "plugin": ["virtualcode/tui"] }

You can also set the token directly in config if you prefer editing over /telegram:

  { "plugin": [["virtualcode", { "token": "YOUR_TOKEN" }]] }

Restart opencode/kilo after editing.
```

**Bot doesn't respond to messages**

```
1. Check /status — is the chat linked to a session?
2. If not linked, use /ls then /link <short ID>
3. If linked, check logs at ~/.config/opencode/telegram-plugin.log
```

**"/telegram" not found in command palette (Ctrl+P)**

```
This is expected for Kilo Code — it does not support the popup dialog.
Just type /telegram <token> directly in the chat input instead.

For OpenCode, make sure virtualcode/tui is registered:

  ~/.config/opencode/tui.json → plugin: ["virtualcode/tui"]

Then restart opencode.
```

**"Invalid token" error**

```
1. Make sure you copied the full token from @BotFather
2. Token format: 8-12 digits, colon, 30-50 alphanumeric/dash chars
   Example: 1234567890:ABCdefGHIjklMNOpqrsTUVwxyzABCDef
3. Try /telegram disconnect then reconnect with the correct token
```

**"Another bot instance running" error**

```
Only one bot can use a token at a time. Check if:
- Another opencode/kilo instance is running
- Another app is using the same bot token
- A previous instance didn't shut down cleanly (wait 30s)
```

**Messages not coming back from the AI**

```
1. Check that the session is still active in the TUI
2. The bot auto-reconnects after failures (5s → 10s → 20s → 30s)
3. Set DEBUG_TELEGRAM=1 to see detailed logs
```

**Session ID not found**

```
1. Use /ls to list sessions (shows short IDs like a1b2c...)
2. Type the first few characters of the short ID: /link a1b2
3. You can also use /use <number> to switch
4. If multiple sessions match, use a longer prefix
```

---

## Architecture

```
virtualcode
├── src/
│   ├── index.ts      Server plugin — bot logic, session bridge, event handling
│   └── tui.ts        TUI plugin — slash command registration, token setup dialog
├── dist/             Compiled JavaScript output
├── install.js        Postinstall script — auto-configures tool config files
├── package.json      npm: virtualcode
├── README.md
└── LICENSE
```

---

## Contributing

Issues and PRs welcome.

```bash
git clone https://github.com/ShaikhWarsi/VirtualCode.git
cd VirtualCode
npm install
npm run build
```

---

## License

MIT
