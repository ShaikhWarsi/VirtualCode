import { writeFileSync, mkdirSync, existsSync, renameSync, chmodSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

function getConfigDir(): string {
  const candidates = [
    join(homedir(), ".config", "opencode"),
    join(homedir(), ".config", "kilo"),
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return candidates[0]
}

const CONFIG_DIR = getConfigDir()
const TOKEN_FILE = join(CONFIG_DIR, "telegram-token.json")
const TOKEN_TMP = TOKEN_FILE + ".tmp"
const LOG_FILE = join(CONFIG_DIR, "telegram-tui.log")
const MAX_LOG_SIZE = 2 * 1024 * 1024
const FILE_MODE = 0o600
const TOKEN_REGEX = /^\d{8,12}:[\w-]{30,50}$/
const MAX_TOKEN_LEN = 100

let logDirEnsured = false
function ensureLogDir() {
  if (logDirEnsured) return
  try { mkdirSync(CONFIG_DIR, { recursive: true }) } catch {}
  logDirEnsured = true
}

function rotateLogIfNeeded() {
  try {
    if (!existsSync(LOG_FILE)) return
    if (statSync(LOG_FILE).size < MAX_LOG_SIZE) return
    try { renameSync(LOG_FILE, LOG_FILE + ".1") } catch {}
  } catch {}
}

let logQueue: Promise<void> = Promise.resolve()
function fileLog(level: string, ...args: unknown[]) {
  logQueue = logQueue.then(() => {
    try {
      ensureLogDir()
      rotateLogIfNeeded()
      const ts = new Date().toISOString()
      const parts = args.map((a) => {
        if (a instanceof Error) return (a.stack || a.message || String(a)).replace(/[\r\n]+/g, " ")
        if (typeof a === "string") return a.replace(/[\r\n]+/g, " ")
        try { return JSON.stringify(a).replace(/[\r\n]+/g, " ") } catch { return String(a) }
      })
      writeFileSync(LOG_FILE, `[${ts}] [${level}] ${parts.join(" ")}\n`, { flag: "a" })
    } catch {}
  }).catch(() => {})
}

function sanitizeTUI(text: string, maxLen = 400): string {
  if (typeof text !== "string") return ""
  let cleaned = text.split("\n").filter((l) => !/^\s*at\s/.test(l)).join(" ").trim()
  cleaned = cleaned.replace(/\s+/g, " ")
  if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen - 3) + "..."
  return cleaned
}

function safeChmod(p: string) {
  try { chmodSync(p, FILE_MODE) } catch {}
}

function saveTokenAtomic(token: string) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(TOKEN_TMP, JSON.stringify({ token }, null, 2))
  safeChmod(TOKEN_TMP)
  try {
    renameSync(TOKEN_TMP, TOKEN_FILE)
  } catch {
    writeFileSync(TOKEN_FILE, JSON.stringify({ token }, null, 2))
  }
  safeChmod(TOKEN_FILE)
}

const TuiPlugin = {
  id: "virtualcode/tui",
  async tui(api: any) {
    try {
      if (!api?.keymap?.registerLayer) {
        fileLog("WARN", "OpenCode TUI API missing keymap.registerLayer; plugin disabled")
        return
      }
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
              try {
                if (!api.ui?.dialog?.replace || !api.ui?.DialogPrompt) {
                  fileLog("WARN", "OpenCode TUI dialog API missing; cannot open setup")
                  return
                }
                api.ui.dialog.replace(() =>
                  api.ui.DialogPrompt({
                    title: "Telegram Setup",
                    placeholder: "Paste your BotFather token here",
                    onConfirm(token: string) {
                      try {
                        if (typeof token !== "string") return
                        const trimmed = token.trim().slice(0, MAX_TOKEN_LEN)
                        if (!trimmed) return
                        if (!TOKEN_REGEX.test(trimmed)) {
                          try {
                            api.ui?.toast?.({
                              title: "Telegram",
                              message: sanitizeTUI("Invalid token format. Expected: 1234567890:ABC-DEF..."),
                              variant: "error",
                              duration: 4000,
                            })
                          } catch {}
                          return
                        }
                        saveTokenAtomic(trimmed)
                        try {
                          api.ui?.toast?.({
                            title: "Telegram",
                            message: sanitizeTUI("Token saved! Bot will connect on next message."),
                            variant: "success",
                            duration: 4000,
                          })
                        } catch {}
                        try { api.ui?.dialog?.clear?.() } catch {}
                      } catch (err) {
                        fileLog("ERROR", "onConfirm failed:", err instanceof Error ? err.message : String(err))
                      }
                    },
                    onCancel() {
                      try { api.ui?.dialog?.clear?.() } catch {}
                    },
                  }),
                )
              } catch (err) {
                fileLog("ERROR", "palette run failed:", err instanceof Error ? err.message : String(err))
              }
            },
          },
        ],
      })
    } catch (err) {
      fileLog("ERROR", "registerLayer failed:", err instanceof Error ? err.message : String(err))
    }
  },
}

export default TuiPlugin
