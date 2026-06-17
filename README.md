# opencode-telegram

A [OpenCode](https://opencode.ai) plugin that bridges your terminal sessions with Telegram.

Send prompts from your phone via Telegram and receive LLM responses in real time. Also lets the LLM send messages back to you via a `telegram_send` tool.

## Features

- **Bidirectional**: Send prompts from Telegram, get responses back
- **`/link` sessions**: Bind a Telegram chat to an OpenCode session
- **`telegram_send` tool**: LLM can proactively message you on Telegram
- **Multi-session**: One chat linked to one session; multiple chats can link to the same session
- **Persistent links**: Session-chat bindings survive restarts

## Installation

```json
// .opencode/opencode.json
{
  "plugins": [
    ["../path/to/opencode-telegram", {
      "token": "YOUR_BOT_TOKEN",
      "allowed_users": [YOUR_TELEGRAM_ID]
    }]
  ]
}
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `token` | `string` | `env.TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `allowed_users` | `number[]` | `null` (all) | Restrict to specific Telegram user IDs |
| `notify_on_reconnect` | `boolean` | `false` | Send reconnection notice to linked chats |

## Commands

- `/link <sessionId>` — Bind this chat to a session
- `/unlink` — Remove binding
- `/status` — Show connection state
- `/sessions` — List recent sessions
- `/help` — Show this help

## License

MIT
