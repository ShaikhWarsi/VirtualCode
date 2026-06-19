import { type Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { Telegraf } from "telegraf"
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const LINK_FILE = join(homedir(), ".config", "opencode", "telegram-links.json")
const LINK_TMP = LINK_FILE + ".tmp"
const TOKEN_FILE = join(homedir(), ".config", "opencode", "telegram-token.json")
const TOKEN_TMP = TOKEN_FILE + ".tmp"
const CONFIG_DIR = join(homedir(), ".config", "opencode")

const TOKEN_REGEX = /^\d+:[\w-]+$/
const MAX_LRU_SIZE = 100
const PENDING_TIMEOUT_MS = 30_000
const RECONNECT_DELAYS = [5_000, 10_000, 20_000, 30_000]

function loadLinks(): Record<number, string> {
  try {
    if (existsSync(LINK_FILE)) {
      return JSON.parse(readFileSync(LINK_FILE, "utf-8"))
    }
  } catch {}
  return {}
}

function persistLinks(links: Record<number, string>) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(LINK_TMP, JSON.stringify(links, null, 2))
  try {
    renameSync(LINK_TMP, LINK_FILE)
  } catch {
    writeFileSync(LINK_FILE, JSON.stringify(links, null, 2))
  }
}

function loadSavedToken(): string | null {
  try {
    if (existsSync(TOKEN_FILE)) {
      const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"))
      if (data?.token) return data.token
    }
  } catch {}
  return null
}

function saveToken(token: string) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(TOKEN_TMP, JSON.stringify({ token }, null, 2))
  try {
    renameSync(TOKEN_TMP, TOKEN_FILE)
  } catch {
    writeFileSync(TOKEN_FILE, JSON.stringify({ token }, null, 2))
  }
}

function isValidToken(token: string): boolean {
  return TOKEN_REGEX.test(token)
}

function userError(err: unknown): string {
  if (!err) return "Unknown error"
  if (err instanceof Error) {
    const first = err.message.split("\n")[0].trim()
    return first || "Unknown error"
  }
  const s = String(err).split("\n")[0].trim()
  return s || "Unknown error"
}

const DEBUG = !!process.env.DEBUG_TELEGRAM

function debugLog(...args: unknown[]) {
  console.error("[telegram-plugin]", ...args)
  if (DEBUG) {
    for (const a of args) {
      if (a instanceof Error) console.error(a)
    }
  }
}

function sanitizeUI(text: string, maxLen = 200): string {
  if (!text) return ""
  let cleaned = text
    .split("\n")
    .filter((line) => !/^\s*at\s/.test(line))
    .join(" ")
    .trim()
  cleaned = cleaned.replace(/\s+/g, " ")
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen - 3).trim() + "..."
  }
  return cleaned
}

const KNOWN_ERRORS: [RegExp, string][] = [
  [/Expected a string starting with "ses"/, "Invalid session ID."],
  [/ECONNRESET/, "Connection lost."],
  [/(409|Conflict)/, "Another bot instance running."],
  [/(401|Unauthorized|invalid.*token)/i, "Invalid token."],
  [/(403|Forbidden)/, "Bot blocked."],
  [/(socket|timeout)/i, "Connection timed out."],
]

function handlePluginError(err: unknown, context: string): string {
  const msg = userError(err)
  debugLog(context + ":", msg)
  for (const [pattern, friendly] of KNOWN_ERRORS) {
    if (pattern.test(msg)) return friendly
  }
  return "Something went wrong."
}

function chunkText(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen))
  }
  return chunks
}

function fmtId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "..." : id
}

type FindResult =
  | { status: "found"; session: any }
  | { status: "ambiguous" }
  | { status: "not_found" }

function findSessionById(id: string, list: any[]): FindResult {
  const exact = list.find((s: any) => s.id === id)
  if (exact) return { status: "found", session: exact }
  const prefix = list.filter((s: any) => s.id.startsWith(id))
  if (prefix.length === 1) return { status: "found", session: prefix[0] }
  if (prefix.length > 1) return { status: "ambiguous" }
  return { status: "not_found" }
}

const TelegramPlugin: Plugin = async ({ client, directory }, options) => {
  const config = options as
    | {
        allowed_users?: number[]
        token?: string
        notify_on_reconnect?: boolean
      }
    | undefined

  const allowedSet = config?.allowed_users?.length ? new Set(config.allowed_users) : null
  const notifyOnReconnect = config?.notify_on_reconnect ?? false

  let bot: Telegraf | null = null
  let botReady = false
  let botStarting = false
  let userStopped = false
  let savedToken: string | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0

  const lastForwardedBySession = new Map<string, string>()
  const pendingTelegram = new Map<string, { chatId: number; timer: ReturnType<typeof setTimeout> }>()

  const links = loadLinks()
  const chatToSession = new Map<number, string>()
  const sessionToChats = new Map<string, Set<number>>()

  function rebuildMaps() {
    chatToSession.clear()
    sessionToChats.clear()
    for (const [chatId, sessionId] of Object.entries(links)) {
      const cid = Number(chatId)
      chatToSession.set(cid, sessionId)
      let set = sessionToChats.get(sessionId)
      if (!set) {
        set = new Set()
        sessionToChats.set(sessionId, set)
      }
      set.add(cid)
    }
  }
  rebuildMaps()

  function addLink(chatId: number, sessionId: string) {
    links[chatId] = sessionId
    chatToSession.set(chatId, sessionId)
    let set = sessionToChats.get(sessionId)
    if (!set) {
      set = new Set()
      sessionToChats.set(sessionId, set)
    }
    set.add(chatId)
    persistLinks(links)
  }

  function removeLink(chatId: number) {
    const sessionId = links[chatId]
    if (!sessionId) return
    delete links[chatId]
    chatToSession.delete(chatId)
    const set = sessionToChats.get(sessionId)
    if (set) {
      set.delete(chatId)
      if (set.size === 0) sessionToChats.delete(sessionId)
    }
    persistLinks(links)
  }

  function lruSet(map: Map<string, string>, key: string, value: string) {
    if (map.has(key)) {
      map.delete(key)
    } else if (map.size >= MAX_LRU_SIZE) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(key, value)
  }

  function setPending(sessionId: string, chatId: number) {
    const existing = pendingTelegram.get(sessionId)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      pendingTelegram.delete(sessionId)
    }, PENDING_TIMEOUT_MS)
    pendingTelegram.set(sessionId, { chatId, timer })
  }

  function clearPending(sessionId: string) {
    const entry = pendingTelegram.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      pendingTelegram.delete(sessionId)
    }
  }

  function scheduleReconnect() {
    if (userStopped || !savedToken) return
    if (reconnectTimer) return
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)]
    reconnectAttempts++
    debugLog("scheduling reconnect in", delay, "ms (attempt", reconnectAttempts + ")")
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null
      if (savedToken && !userStopped) {
        await startBot(savedToken)
      }
    }, delay)
  }

  async function sendToChats(chats: Iterable<number>, text: string) {
    if (!botReady) return
    const chunks = chunkText(text)
    for (const chatId of chats) {
      for (const chunk of chunks) {
        try {
          await bot!.telegram.sendMessage(chatId, chunk)
        } catch (err) {
          const msg = handlePluginError(err, "sendMessage")
          if (msg.includes("blocked") || msg.includes("Invalid token")) {
            botReady = false
            scheduleReconnect()
          }
        }
      }
    }
  }

  async function sendToSession(sessionId: string, text: string) {
    const chats = sessionToChats.get(sessionId)
    if (!chats) return
    await sendToChats(chats, text)
  }

  async function startBot(token: string) {
    if (botStarting) return
    if (!isValidToken(token)) {
      debugLog("startBot: invalid token format")
      return
    }
    botStarting = true
    botReady = false
    userStopped = false
    savedToken = token
    reconnectAttempts = 0
    try {
      try { bot?.stop() } catch {}
      bot = new Telegraf(token)
      bot.catch((err) => {
        handlePluginError(err, "bot.catch")
      })

      bot.command("start", async (ctx) => {
        if (allowedSet && !allowedSet.has(ctx.from.id)) return
        await ctx.reply(
          "virtualcode - OpenCode Telegram bridge\n\n" +
          "Quick setup:\n" +
          "1. /ls - list your sessions\n" +
          "2. /link <ID> - bind this chat\n" +
          "3. Send any message to talk to OpenCode\n\n" +
          "Type /help for all commands."
        )
      })

      bot.command("link", async (ctx) => {
        if (allowedSet && !allowedSet.has(ctx.from.id)) return
        const arg = ctx.payload.trim()
        if (!arg) {
          await ctx.reply("Usage: /link <sessionID>")
          return
        }
        try {
          const list = await client.session.list()
          if (list.error || !list.data) {
            await ctx.reply("Could not load sessions.")
            return
          }
          const result = findSessionById(arg, list.data)
          if (result.status === "not_found") {
            await ctx.reply("Session not found.")
            return
          }
          if (result.status === "ambiguous") {
            await ctx.reply("Multiple sessions match. Use the full ID from /ls.")
            return
          }
          const old = links[ctx.chat.id]
          addLink(ctx.chat.id, result.session.id)
          if (old) {
            await ctx.reply("Switched to " + fmtId(result.session.id) + " (from " + fmtId(old) + ")")
          } else {
            await ctx.reply("Linked to " + (result.session.title || fmtId(result.session.id)))
          }
        } catch (err) {
          const msg = handlePluginError(err, "/link")
          await ctx.reply(sanitizeUI(msg))
        }
      })

      bot.command("unlink", async (ctx) => {
        if (allowedSet && !allowedSet.has(ctx.from.id)) return
        if (!links[ctx.chat.id]) {
          await ctx.reply("Not linked.")
          return
        }
        removeLink(ctx.chat.id)
        await ctx.reply("Unlinked.")
      })

      bot.command("status", async (ctx) => {
        if (allowedSet && !allowedSet.has(ctx.from.id)) return
        const sessionId = links[ctx.chat.id]
        if (!sessionId) {
          await ctx.reply("Not linked. Use /link <ID>")
          return
        }
        await ctx.reply(
          "Connected | Session: " + fmtId(sessionId) + " | Project: " + (directory || "none")
        )
      })

      bot.command(["ls", "sessions"], async (ctx) => {
        if (allowedSet && !allowedSet.has(ctx.from.id)) return
        try {
          const res = await client.session.list()
          if (res.error || !res.data) {
            await ctx.reply("Could not load sessions.")
            return
          }
          const current = links[ctx.chat.id]
          const lines = res.data.slice(-20).map((s: any, i: number, arr: any[]) => {
            const num = arr.length - i
            const marker = s.id === current ? " *" : ""
            const label = s.title || s.id.slice(0, 16)
            return num + ". " + label + " -- " + s.id + marker
          })
          await ctx.reply("Sessions:\n" + (lines.length ? lines.join("\n") : "None"))
        } catch (err) {
          const msg = handlePluginError(err, "/ls")
          await ctx.reply(sanitizeUI(msg))
        }
      })

      bot.command("use", async (ctx) => {
        if (allowedSet && !allowedSet.has(ctx.from.id)) return
        const arg = ctx.payload.trim()
        if (!arg) {
          await ctx.reply("Usage: /use <number|ID>")
          return
        }
        try {
          const res = await client.session.list()
          if (res.error || !res.data) {
            await ctx.reply("Could not load sessions.")
            return
          }
          const num = parseInt(arg)
          if (!isNaN(num) && num > 0) {
            if (num > res.data.length) {
              await ctx.reply("Only " + res.data.length + " sessions available.")
              return
            }
            const s = res.data[res.data.length - num]
            if (!s) return
            addLink(ctx.chat.id, s.id)
            await ctx.reply("Switched to " + (s.title || fmtId(s.id)))
            return
          }
          const result = findSessionById(arg, res.data)
          if (result.status === "not_found") {
            await ctx.reply("Session not found.")
            return
          }
          if (result.status === "ambiguous") {
            await ctx.reply("Multiple sessions match. Use the full ID from /ls.")
            return
          }
          addLink(ctx.chat.id, result.session.id)
          await ctx.reply("Switched to " + (result.session.title || fmtId(result.session.id)))
        } catch (err) {
          const msg = handlePluginError(err, "/use")
          await ctx.reply(sanitizeUI(msg))
        }
      })

      bot.command("history", async (ctx) => {
        if (allowedSet && !allowedSet.has(ctx.from.id)) return
        const sessionId = links[ctx.chat.id]
        if (!sessionId) {
          await ctx.reply("Not linked. Use /link <ID>")
          return
        }
        try {
          const limitText = ctx.payload.trim()
          const limit = limitText ? Math.min(parseInt(limitText) || 20, 100) : 20
          const res = await client.session.messages({ path: { id: sessionId }, query: { directory, limit } })
          if (res.error || !res.data || res.data.length === 0) {
            await ctx.reply("No messages found.")
            return
          }
          const lines: string[] = []
          for (const msg of res.data) {
            const role = msg.info.role === "user" ? "[User]" : "[AI]"
            const text = (msg.parts as any[])
              .filter((p: any) => p.type === "text" && !p.synthetic)
              .map((p: any) => p.text)
              .join("\n")
              .trim()
            if (!text) continue
            const truncated = text.length > 500 ? text.slice(0, 500) + "..." : text
            lines.push(role + " " + truncated)
          }
          if (lines.length === 0) {
            await ctx.reply("No text messages found.")
            return
          }
          const text = lines.join("\n\n")
          for (const chunk of chunkText(text)) {
            await ctx.reply(chunk)
          }
        } catch (err) {
          const msg = handlePluginError(err, "/history")
          await ctx.reply(sanitizeUI(msg))
        }
      })

      bot.command("help", async (ctx) => {
        if (allowedSet && !allowedSet.has(ctx.from.id)) return
        await ctx.reply(
          "/link <sessionId>     - Bind this chat to a session\n" +
          "/unlink               - Remove binding\n" +
          "/status               - Show connection state\n" +
          "/ls                   - List recent sessions\n" +
          "/use <number|ID>      - Switch active session\n" +
          "/history [N]          - View last N messages\n" +
          "/help                 - Show this help\n\n" +
          "Any other message will be sent to the linked session."
        )
      })

      bot.on(["photo", "sticker", "document", "video", "audio", "voice"], async (ctx) => {
        if (allowedSet && !allowedSet.has(ctx.from.id)) return
        await ctx.reply("Only text messages are supported.")
      })

      bot.on("text", async (ctx) => {
        if (allowedSet && !allowedSet.has(ctx.from.id)) return
        const sessionId = links[ctx.chat.id]
        if (!sessionId) {
          await ctx.reply("Not linked. Use /link <ID>")
          return
        }
        const working = await ctx.reply("...")
        setPending(sessionId, ctx.chat.id)
        try {
          const res = await client.session.prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: "text", text: ctx.message.text, metadata: { opencodeTelegram: true } }],
            },
            query: { directory },
          })
          if (res.error) {
            const msg = handlePluginError(res.error, "prompt")
            await ctx.reply(sanitizeUI(msg))
          }
        } catch (err) {
          const msg = handlePluginError(err, "prompt")
          await ctx.reply(sanitizeUI(msg))
        }
        clearPending(sessionId)
        try { await ctx.deleteMessage(working.message_id) } catch {}
      })

      if (notifyOnReconnect) {
        for (const chatId of Object.keys(links)) {
          bot.telegram.sendMessage(Number(chatId), "Telegram bridge reconnected.").catch(() => {})
        }
      }

      try {
        await bot.telegram.getMe()
      } catch (err) {
        const msg = handlePluginError(err, "getMe")
        debugLog("startBot failed:", msg)
        botStarting = false
        botReady = false
        scheduleReconnect()
        return
      }
      botReady = true
      botStarting = false
      bot.launch().catch((err) => {
        handlePluginError(err, "bot.launch")
        botReady = false
        scheduleReconnect()
      })
    } catch (err) {
      handlePluginError(err, "startBot")
      botStarting = false
      botReady = false
      scheduleReconnect()
    }
  }

  const configToken = config?.token
  const envToken = process.env.TELEGRAM_BOT_TOKEN
  const fileToken = loadSavedToken()
  const existingToken = configToken || envToken || fileToken
  if (existingToken) {
    await startBot(existingToken)
  }

  return {
    async event({ event }) {
      if (!botReady) return
      try {
        if (event.type === "session.error") {
          const sessionId = event.properties.sessionID
          if (sessionId) {
            const err = event.properties.error
            const msg = handlePluginError(err, "session.error")
            sendToSession(sessionId, msg)
          }
          return
        }
        if (event.type === "session.status" && event.properties.status.type === "idle") {
          const sid = event.properties.sessionID
          const pending = pendingTelegram.get(sid)
          const chats = pending ? new Set([pending.chatId]) : sessionToChats.get(sid)
          if (!chats || chats.size === 0) return
          let msgs
          try {
            msgs = await client.session.messages({ path: { id: sid }, query: { directory, limit: 5 } })
          } catch { return }
          if (msgs.error || !msgs.data) return
          const last = [...msgs.data].reverse().find((m: any) => m.info.role === "assistant")
          if (!last || lastForwardedBySession.get(sid) === last.info.id) return
          lruSet(lastForwardedBySession, sid, last.info.id)
          const text = (last.parts as any[])
            .filter((p: any) => p.type === "text" && !p.synthetic)
            .map((p: any) => p.text)
            .join("\n")
          if (text) sendToChats(chats, text)
        }
      } catch (err) {
        debugLog("event handler:", userError(err))
      }
    },

    "chat.message": async (_input, output) => {
      try {
        if (!botReady && !botStarting) {
          const configToken = config?.token
          const envToken = process.env.TELEGRAM_BOT_TOKEN
          const fileToken = loadSavedToken()
          const saved = configToken || envToken || fileToken
          if (saved) {
            await startBot(saved)
          }
        }
        for (const part of output.parts as any[]) {
          if (part.type !== "text") continue
          const text = part.text

          if (text.startsWith("/telegram")) {
            const args = text.slice("/telegram".length).trim().toLowerCase()

            if (args === "disconnect" || args === "stop") {
              userStopped = true
              if (reconnectTimer) {
                clearTimeout(reconnectTimer)
                reconnectTimer = null
              }
              try { bot?.stop() } catch {}
              botReady = false
              bot = null
              botStarting = false
              savedToken = null
              if (loadSavedToken()) saveToken("")
              part.text = "Telegram bot disconnected and token removed."
              return
            }

            if (args === "status" || args === "") {
              if (botReady) {
                part.text =
                  "Telegram bot is connected.\n" +
                  "- /telegram <new_token> - Change bot token\n" +
                  "- /telegram disconnect - Stop bot and remove token\n" +
                  "- /telegram - Open setup dialog (type /telegram in command palette)"
              } else {
                part.text =
                  "Telegram bot is not connected.\n" +
                  "- /telegram <your_bot_token> - Connect with a token\n" +
                  "- /telegram - Open setup dialog (type /telegram in command palette)"
              }
              return
            }

            const token = args
            if (!isValidToken(token)) {
              part.text = "Invalid token."
              return
            }
            saveToken(token)
            await startBot(token)
            part.text = botReady ? "Connected." : "Invalid token."
            return
          }
        }
      } catch (err) {
        debugLog("chat.message:", userError(err))
      }
    },

    tool: {
      telegram_send: tool({
        description: "Send a message to Telegram chat(s) linked to the current session",
        args: {
          text: tool.schema.string().describe("Text to send"),
          sessionId: tool.schema.string().optional().describe("Target session ID (defaults to current)"),
        },
        async execute({ text, sessionId }, ctx) {
          const targetId = sessionId || ctx.sessionID
          await sendToSession(targetId, text)
          return { output: "Message sent to Telegram" }
        },
      }),
    },

    async dispose() {
      userStopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      for (const [, entry] of pendingTelegram) {
        clearTimeout(entry.timer)
      }
      pendingTelegram.clear()
      lastForwardedBySession.clear()
      try { bot?.stop() } catch {}
      botReady = false
      botStarting = false
      bot = null
      savedToken = null
    },
  }
}

export default {
  id: "virtualcode",
  server: TelegramPlugin,
}
