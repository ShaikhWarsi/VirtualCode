import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const CONFIG_DIR = join(homedir(), ".config", "opencode")
const TOKEN_FILE = join(CONFIG_DIR, "telegram-token.json")

const TuiPlugin: TuiPluginModule = {
  id: "@opencode-ai/plugin-telegram/tui",
  tui: async (api) => {
    const cmd = api.command
    if (!cmd) return

    cmd.register(() => [
      {
        title: "Telegram: Setup",
        value: "telegram.setup",
        description: "Open Telegram setup wizard",
        category: "Telegram",
        onSelect(dialog) {
          if (dialog) {
            dialog.replace(() =>
              api.ui.DialogPrompt({
                title: "Telegram Setup",
                placeholder: "Paste your BotFather token",
                onConfirm(token) {
                  if (!token?.trim()) return
                  mkdirSync(CONFIG_DIR, { recursive: true })
                  writeFileSync(TOKEN_FILE, JSON.stringify({ token: token.trim() }, null, 2))
                  api.ui.toast({ title: "Telegram", message: "Token saved! Type any message to connect.", variant: "success", duration: 4000 })
                  dialog.clear()
                },
                onCancel() {
                  dialog.clear()
                },
              }),
            )
          } else {
            api.ui.toast({ title: "Telegram", message: "Type /telegram <token> in chat to set up", variant: "info", duration: 5000 })
          }
        },
      },
    ])
  },
}

export default TuiPlugin
