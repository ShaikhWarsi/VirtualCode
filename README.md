# virtualcode

```
        _      _               _               _      
 __   _(_)_ __| |_ _   _  __ _| | ___ ___   __| | ___ 
 \ \ / / | '__| __| | | |/ _` | |/ __/ _ \ / _` |/ _ \
  \ V /| | |  | |_| |_| | (_| | | (_| (_) | (_| |  __/
   \_/ |_|_|   \__|\__,_|\__,_|_|\___\___/ \__,_|\___|

    Talk to your terminal from your phone.
```

Telegram bridge for **OpenCode** and **Kilo Code**.

---

## Setup

```bash
npm install -g virtualcode
```

That's it. The installer auto-configures everything. Now:

1. Run `opencode` or `kilo`
2. Type **`/telegram <token>`** (get token from [@BotFather](https://t.me/botfather))
3. On your phone, open Telegram, find your bot
4. Send `/ls` → `/link <shortID>` → done

Any message you send in that Telegram chat goes straight to the AI. Responses come back automatically.

---

## Telegram Commands

| Command | What it does |
|---------|-------------|
| `/ls` | List sessions |
| `/link <ID>` | Bind this chat to a session |
| `/unlink` | Unbind |
| `/use <N\|ID>` | Switch session |
| `/status` | Connection state |
| `/model` | Show/set model override |
| `/models` | List models |
| `/session` | Session details |
| `/rename <title>` | Rename session |
| `/history [N]` | Last N messages |
| `/agents` | List agents |
| `/help` | All commands |

## TUI Commands

| Command | What it does |
|---------|-------------|
| `/telegram` | Open setup dialog (Ctrl+P) |
| `/telegram <token>` | Connect with a token |
| `/telegram status` | Check connection |
| `/telegram disconnect` | Stop bot + remove token |

---

## Config

Set `token`, `allowed_users`, or `notify_on_reconnect` in your config if you want (not required):

```json
{
  "plugin": [["virtualcode", { "token": "...", "allowed_users": [123] }]]
}
```

Defaults: `TELEGRAM_BOT_TOKEN` env var, or set it via `/telegram <token>` in the TUI.

---

## License

MIT
