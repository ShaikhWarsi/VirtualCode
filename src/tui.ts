import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const CONFIG_DIR = join(homedir(), ".config", "opencode")
const TOKEN_FILE = join(CONFIG_DIR, "telegram-token.json")

const TuiPlugin = {
  id: "virtualcode/tui",
  async tui(api: any) {
    api.keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: "telegram.setup",
          title: "/telegram",
          slashName: "telegram",
          desc: "Setup or change your Telegram bot token",
          category: "Telegram",
          run() {
            api.ui.dialog.replace(() =>
              api.ui.DialogPrompt({
                title: "Telegram Setup",
                placeholder: "Paste your BotFather token here",
                onConfirm(token: string) {
                  if (!token?.trim()) return
                  mkdirSync(CONFIG_DIR, { recursive: true })
                  writeFileSync(TOKEN_FILE, JSON.stringify({ token: token.trim() }, null, 2))
                  api.ui.toast({
                    title: "Telegram",
                    message: "Token saved! Bot will connect on next message.",
                    variant: "success",
                    duration: 4000,
                  })
                  api.ui.dialog.clear()
                },
                onCancel() {
                  api.ui.dialog.clear()
                },
              }),
            )
          },
        },
      ],
    })
  },
}

export default TuiPlugin
