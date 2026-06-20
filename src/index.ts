import { type Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { Telegraf } from "telegraf"
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const LINK_FILE = join(homedir(), ".config", "opencode", "telegram-links.json")
const LINK_TMP = LINK_FILE + ".tmp"
const TOKEN_FILE = join(homedir(), ".config", "opencode", "telegram-token.json")
const TOKEN_TMP = TOKEN_FILE + ".tmp"
const MODELS_FILE = join(homedir(), ".config", "opencode", "telegram-models.json")
const MODELS_TMP = MODELS_FILE + ".tmp"
const CONFIG_DIR = join(homedir(), ".config", "opencode")
const LOG_FILE = join(CONFIG_DIR, "telegram-plugin.log")
const LOG_FILE_OLD = LOG_FILE + ".1"
const MAX_LOG_SIZE = 5 * 1024 * 1024

const TOKEN_REGEX = /^\d{8,12}:[\w-]{30,50}$/
const MAX_LRU_SIZE = 100
const PENDING_TIMEOUT_MS = 30_000
const RECONNECT_DELAYS = [5_000, 10_000, 20_000, 30_000]
const MAX_TELEGRAM_INPUT = 4096
const MAX_TUI_TEXT = 400
const MIN_PREFIX_LEN = 4
const MAX_TOKENS_PER_CHUNK = 25
const MIN_HISTORY_LIMIT = 1
const FILE_MODE = 0o600

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
    if (existsSync(LOG_FILE_OLD)) {
      try { writeFileSync(LOG_FILE_OLD, "", { flag: "w" }) } catch {}
    }
    try { renameSync(LOG_FILE, LOG_FILE_OLD) } catch {}
  } catch {}
}

let logWriteQueue: Promise<void> = Promise.resolve()
function fileLog(level: string, ...args: unknown[]) {
  logWriteQueue = logWriteQueue.then(() => {
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

function safeChmod(p: string) {
  try { chmodSync(p, FILE_MODE) } catch {}
}

function atomicWrite(path: string, tmp: string, data: string) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(tmp, data)
  safeChmod(tmp)
  try {
    renameSync(tmp, path)
  } catch {
    writeFileSync(path, data)
  }
  safeChmod(path)
}

function loadLinks(): Record<number, string> {
  try {
    if (existsSync(LINK_FILE)) {
      const raw = readFileSync(LINK_FILE, "utf-8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<number, string>
      }
    }
  } catch (err) {
    debugLog("loadLinks failed:", userError(err))
  }
  return {}
}

function persistLinks(links: Record<number, string>) {
  atomicWrite(LINK_FILE, LINK_TMP, JSON.stringify(links, null, 2))
}

function loadSavedToken(): string | null {
  try {
    if (existsSync(TOKEN_FILE)) {
      const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"))
      if (typeof data?.token === "string" && data.token.length > 0) return data.token
    }
  } catch (err) {
    debugLog("loadSavedToken failed:", userError(err))
  }
  return null
}

function clearSavedToken() {
  try {
    if (existsSync(TOKEN_FILE)) renameSync(TOKEN_FILE, TOKEN_FILE + ".bak")
  } catch {}
}

function saveToken(token: string) {
  atomicWrite(TOKEN_FILE, TOKEN_TMP, JSON.stringify({ token }, null, 2))
}

type ModelPref = { providerID: string; modelID: string }
const sessionModelPrefs = new Map<string, ModelPref>()

function loadModelPrefs(): Map<string, ModelPref> {
  const m = new Map<string, ModelPref>()
  try {
    if (existsSync(MODELS_FILE)) {
      const raw = readFileSync(MODELS_FILE, "utf-8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [sid, pref] of Object.entries(parsed)) {
          const p = pref as any
          if (p && typeof p.providerID === "string" && typeof p.modelID === "string") {
            m.set(sid, { providerID: p.providerID, modelID: p.modelID })
          }
        }
      }
    }
  } catch (err) {
    debugLog("loadModelPrefs failed:", userError(err))
  }
  return m
}

function persistModelPrefs() {
  const obj: Record<string, ModelPref> = {}
  for (const [sid, pref] of sessionModelPrefs) {
    obj[sid] = pref
  }
  atomicWrite(MODELS_FILE, MODELS_TMP, JSON.stringify(obj, null, 2))
}

function setModelPref(sessionId: string, providerID: string, modelID: string) {
  sessionModelPrefs.set(sessionId, { providerID, modelID })
  persistModelPrefs()
}

function clearModelPref(sessionId: string) {
  sessionModelPrefs.delete(sessionId)
  persistModelPrefs()
}

function isValidToken(token: string): boolean {
  if (typeof token !== "string") return false
  if (token.length > 100) return false
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
  if (DEBUG) fileLog("DEBUG", ...args)
}

function errorLog(context: string, err: unknown) {
  fileLog("ERROR", context, userError(err))
  if (DEBUG && err instanceof Error) fileLog("DEBUG", err.stack)
}

function sanitizeUI(text: string, maxLen = 200): string {
  if (!text) return ""
  let cleaned = String(text)
    .split("\n")
    .filter((line) => !/^\s*at\s/.test(line))
    .join(" ")
    .trim()
  cleaned = cleaned.replace(/\s+/g, " ")
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, Math.max(0, maxLen - 3)).trim() + "..."
  }
  return cleaned
}

function sanitizeTUI(text: string, maxLen = MAX_TUI_TEXT): string {
  const s = sanitizeUI(text, maxLen)
  if (!s) return ""
  return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s
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
  errorLog(context, err)
  for (const [pattern, friendly] of KNOWN_ERRORS) {
    if (pattern.test(msg)) return friendly
  }
  return "Something went wrong."
}

function chunkText(text: string, maxLen = 4000): string[] {
  if (!text) return [""]
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen))
  }
  return chunks
}

function fmtId(id: string): string {
  if (typeof id !== "string") return "(invalid)"
  return id.length > 12 ? id.slice(0, 12) + "..." : id
}

type FindResult =
  | { status: "found"; session: any }
  | { status: "ambiguous" }
  | { status: "not_found" }

function findSessionById(id: string, list: any[]): FindResult {
  if (typeof id !== "string" || !Array.isArray(list)) return { status: "not_found" }
  const exact = list.find((s: any) => s && typeof s.id === "string" && s.id === id)
  if (exact) return { status: "found", session: exact }
  if (id.length < MIN_PREFIX_LEN) return { status: "not_found" }
  const prefix = list.filter((s: any) => s && typeof s.id === "string" && s.id.startsWith(id))
  if (prefix.length === 1) return { status: "found", session: prefix[0] }
  if (prefix.length > 1) return { status: "ambiguous" }
  return { status: "not_found" }
}

function safeList(arr: any[]): any[] {
  if (!Array.isArray(arr)) return []
  return arr.filter((s) => s && typeof s === "object" && typeof s.id === "string")
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
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

  const savedPrefs = loadModelPrefs()
  for (const [sid, pref] of savedPrefs) {
    sessionModelPrefs.set(sid, pref)
  }

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
    if (reconnectAttempts >= 10) {
      debugLog("reconnect attempts exhausted; giving up until next event")
      return
    }
    const delayMs = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)]
    reconnectAttempts++
    debugLog("scheduling reconnect in", delayMs, "ms (attempt", reconnectAttempts + ")")
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null
      if (savedToken && !userStopped) {
        await startBot(savedToken)
      }
    }, delayMs)
  }

  async function sendToChats(chats: Iterable<number>, text: string): Promise<boolean> {
    if (!botReady || !bot) return false
    const safeText = sanitizeUI(text, 4000)
    const chunks = chunkText(safeText, 4000)
    let sentAny = false
    for (const chatId of chats) {
      for (const chunk of chunks) {
        let attempt = 0
        while (attempt < 2) {
          try {
            await bot!.telegram.sendMessage(chatId, chunk)
            sentAny = true
            break
          } catch (err) {
            attempt++
            const msg = handlePluginError(err, "sendMessage")
            if (msg.includes("blocked")) {
              removeLink(chatId)
              break
            }
            if (msg.includes("Invalid token")) {
              botReady = false
              scheduleReconnect()
              return sentAny
            }
            if (attempt >= 2) {
              debugLog("sendMessage gave up for chat", chatId, ":", msg)
            } else {
              await delay(500)
            }
          }
        }
        if (chunks.length > MAX_TOKENS_PER_CHUNK) {
          await delay(50)
        }
      }
    }
    return sentAny
  }

  async function sendToSession(sessionId: string, text: string): Promise<boolean> {
    const chats = sessionToChats.get(sessionId)
    if (!chats) return false
    return await sendToChats(chats, text) ?? false
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
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        try {
          await ctx.reply(
            "virtualcode - OpenCode Telegram bridge\n\n" +
            "Quick setup:\n" +
            "1. /ls - list your sessions\n" +
            "2. /link <ID> - bind this chat\n" +
            "3. Send any message to talk to OpenCode\n\n" +
            "Type /help for all commands."
          )
        } catch {}
      })

      bot.command("link", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        const arg = (ctx.payload || "").trim().slice(0, 200)
        if (!arg) {
          try { await ctx.reply("Usage: /link <sessionID>") } catch {}
          return
        }
        try {
          const list = await client.session.list()
          if (list.error || !list.data) {
            try { await ctx.reply("Could not load sessions.") } catch {}
            return
          }
          const sessions = safeList(list.data)
          const result = findSessionById(arg, sessions)
          if (result.status === "not_found") {
            try { await ctx.reply(arg.length < MIN_PREFIX_LEN ? "Prefix too short (min 4 chars)." : "Session not found.") } catch {}
            return
          }
          if (result.status === "ambiguous") {
            try { await ctx.reply("Multiple sessions match. Use the full ID from /ls.") } catch {}
            return
          }
          const old = links[ctx.chat.id]
          addLink(ctx.chat.id, result.session.id)
          if (old) {
            try { await ctx.reply("Switched to " + fmtId(result.session.id) + " (from " + fmtId(old) + ")") } catch {}
          } else {
            try { await ctx.reply("Linked to " + (result.session.title || fmtId(result.session.id))) } catch {}
          }
        } catch (err) {
          const msg = handlePluginError(err, "/link")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
      })

      bot.command("unlink", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        if (!links[ctx.chat.id]) {
          try { await ctx.reply("Not linked.") } catch {}
          return
        }
        removeLink(ctx.chat.id)
        try { await ctx.reply("Unlinked.") } catch {}
      })

      bot.command("status", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        const sessionId = links[ctx.chat.id]
        if (!sessionId) {
          try { await ctx.reply("Not linked. Use /link <ID>") } catch {}
          return
        }
        try {
          await ctx.reply(
            "Connected | Session: " + fmtId(sessionId) + " | Project: " + (directory || "none")
          )
        } catch {}
      })

      bot.command(["ls", "sessions"], async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        try {
          const res = await client.session.list()
          if (res.error || !res.data) {
            try { await ctx.reply("Could not load sessions.") } catch {}
            return
          }
          const current = links[ctx.chat.id]
          const sessions = safeList(res.data)
          const recent = sessions.slice(-20)
          const lines = recent.map((s: any, i: number) => {
            const num = recent.length - i
            const marker = s.id === current ? " *" : ""
            const label = (s.title || s.id.slice(0, 16)).slice(0, 60)
            return num + ". " + label + " -- " + s.id + marker
          })
          try { await ctx.reply("Sessions:\n" + (lines.length ? lines.join("\n") : "None")) } catch {}
        } catch (err) {
          const msg = handlePluginError(err, "/ls")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
      })

      bot.command("use", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        const arg = (ctx.payload || "").trim().slice(0, 200)
        if (!arg) {
          try { await ctx.reply("Usage: /use <number|ID>") } catch {}
          return
        }
        try {
          const res = await client.session.list()
          if (res.error || !res.data) {
            try { await ctx.reply("Could not load sessions.") } catch {}
            return
          }
          const sessions = safeList(res.data)
          const num = parseInt(arg)
          if (!isNaN(num) && num > 0 && num <= sessions.length) {
            const s = sessions[sessions.length - num]
            addLink(ctx.chat.id, s.id)
            try { await ctx.reply("Switched to " + (s.title || fmtId(s.id))) } catch {}
            return
          }
          if (!isNaN(num) && num > 0) {
            try { await ctx.reply("Only " + sessions.length + " sessions available.") } catch {}
            return
          }
          const result = findSessionById(arg, sessions)
          if (result.status === "not_found") {
            try { await ctx.reply(arg.length < MIN_PREFIX_LEN ? "Prefix too short (min 4 chars)." : "Session not found.") } catch {}
            return
          }
          if (result.status === "ambiguous") {
            try { await ctx.reply("Multiple sessions match. Use the full ID from /ls.") } catch {}
            return
          }
          addLink(ctx.chat.id, result.session.id)
          try { await ctx.reply("Switched to " + (result.session.title || fmtId(result.session.id))) } catch {}
        } catch (err) {
          const msg = handlePluginError(err, "/use")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
      })

      bot.command("history", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        const sessionId = links[ctx.chat.id]
        if (!sessionId) {
          try { await ctx.reply("Not linked. Use /link <ID>") } catch {}
          return
        }
        try {
          const limitText = (ctx.payload || "").trim().slice(0, 10)
          let limit = MIN_HISTORY_LIMIT
          if (limitText) {
            const parsed = parseInt(limitText)
            if (!isNaN(parsed) && parsed > 0) {
              limit = Math.min(parsed, 100)
            }
          } else {
            limit = 20
          }
          const res = await client.session.messages({ path: { id: sessionId }, query: { directory, limit } })
          if (res.error || !res.data || res.data.length === 0) {
            try { await ctx.reply("No messages found.") } catch {}
            return
          }
          const lines: string[] = []
          for (const msg of res.data) {
            if (!msg || !msg.info) continue
            const role = msg.info.role === "user" ? "[User]" : "[AI]"
            const parts = Array.isArray(msg.parts) ? msg.parts : []
            const text = parts
              .filter((p: any) => p && p.type === "text" && !p.synthetic)
              .map((p: any) => String(p.text || ""))
              .join("\n")
              .trim()
            if (!text) continue
            const truncated = text.length > 500 ? text.slice(0, 500) + "..." : text
            lines.push(role + " " + truncated)
          }
          if (lines.length === 0) {
            try { await ctx.reply("No text messages found.") } catch {}
            return
          }
          const text = lines.join("\n\n")
          for (const chunk of chunkText(text)) {
            try { await ctx.reply(chunk) } catch {}
          }
        } catch (err) {
          const msg = handlePluginError(err, "/history")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
      })

      bot.command(["models", "model_list"], async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        try {
          const res = await client.config.providers()
          if (res.error || !res.data) {
            try { await ctx.reply("Could not load models.") } catch {}
            return
          }
          const providers = res.data.providers
          if (!Array.isArray(providers) || providers.length === 0) {
            try { await ctx.reply("No providers available.") } catch {}
            return
          }
          const lines: string[] = ["Models:"]
          for (const provider of providers) {
            if (!provider || !provider.models) continue
            const models = Object.values(provider.models) as any[]
            const active = models.filter((m: any) => !m?.status || m?.status === "active")
            if (active.length === 0) continue
            lines.push("")
            lines.push((provider.name || provider.id) + ":")
            for (const model of active.slice(0, 15)) {
              const mid = typeof model.id === "string" ? model.id : "?"
              const nm = (typeof model.name === "string" ? model.name : mid).slice(0, 50)
              lines.push("  " + provider.id + "/" + mid + " - " + nm)
            }
            if (active.length > 15) {
              lines.push("  ... and " + (active.length - 15) + " more")
            }
          }
          if (lines.length === 1) {
            try { await ctx.reply("No models available.") } catch {}
            return
          }
          const text = lines.join("\n")
          for (const chunk of chunkText(text)) {
            try { await ctx.reply(chunk) } catch {}
          }
        } catch (err) {
          const msg = handlePluginError(err, "/models")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
      })

      bot.command("model", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        const sessionId = links[ctx.chat.id]
        if (!sessionId) {
          try { await ctx.reply("Not linked. Use /link <ID>") } catch {}
          return
        }
        const arg = (ctx.payload || "").trim().slice(0, 200)

        if (!arg) {
          const current = sessionModelPrefs.get(sessionId)
          if (current) {
            try { await ctx.reply("Model: " + current.providerID + "/" + current.modelID) } catch {}
          } else {
            try { await ctx.reply("No model override set. Send /models to see available models, or /model <providerID/modelID> to set one.") } catch {}
          }
          return
        }

        if (arg === "clear" || arg === "off" || arg === "reset") {
          clearModelPref(sessionId)
          try { await ctx.reply("Model override cleared. Session will use default.") } catch {}
          return
        }

        try {
          const res = await client.config.providers()
          if (res.error || !res.data) {
            try { await ctx.reply("Could not load models.") } catch {}
            return
          }
          const providers = res.data.providers
          if (!Array.isArray(providers)) {
            try { await ctx.reply("Could not load models.") } catch {}
            return
          }

          const parts = arg.split("/")
          let providerID: string | undefined
          let searchID: string

          if (parts.length === 2) {
            providerID = parts[0].trim()
            searchID = parts[1].trim()
          } else {
            searchID = arg.trim()
            for (const provider of providers) {
              if (!provider || !provider.models) continue
              for (const mid of Object.keys(provider.models)) {
                if (mid === searchID || mid.startsWith(searchID)) {
                  providerID = provider.id
                  break
                }
              }
              if (providerID) break
            }
            if (!providerID) {
              try { await ctx.reply("Model not found. Use /models to see available models. Try: /model <providerID>/<modelID>") } catch {}
              return
            }
          }

          let found = false
          for (const provider of providers) {
            if (!provider || provider.id !== providerID || !provider.models) continue
            const match = Object.keys(provider.models).find((mid) => mid === searchID || mid.startsWith(searchID))
            if (match) {
              setModelPref(sessionId, providerID, match)
              const m = (provider.models as any)[match]
              const modelName = typeof m?.name === "string" ? m.name : match
              try { await ctx.reply("Model set to " + providerID + "/" + match + " (" + modelName + ")") } catch {}
              found = true
              break
            }
          }

          if (!found) {
            const lines: string[] = ["Model not found in " + providerID + ". Available models:"]
            for (const provider of providers) {
              if (!provider || provider.id !== providerID || !provider.models) continue
              for (const mid of Object.keys(provider.models)) {
                lines.push("  " + mid)
              }
            }
            try { await ctx.reply(lines.join("\n")) } catch {}
          }
        } catch (err) {
          const msg = handlePluginError(err, "/model")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
      })

      bot.command("session", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        const sessionId = links[ctx.chat.id]
        if (!sessionId) {
          try { await ctx.reply("Not linked. Use /link <ID>") } catch {}
          return
        }
        try {
          const res = await client.session.get({ path: { id: sessionId } })
          if (res.error || !res.data) {
            try { await ctx.reply("Could not load session info.") } catch {}
            return
          }
          const s = res.data as any
          const lines = [
            "Title: " + (s.title || "(untitled)"),
            "ID: " + s.id,
            "Project: " + (s.directory || "none"),
            "Created: " + (s.time?.created ? new Date(s.time.created).toLocaleString() : "?"),
            "Updated: " + (s.time?.updated ? new Date(s.time.updated).toLocaleString() : "?"),
          ]
          if (s.summary) {
            lines.push("Files: " + (s.summary.files ?? 0) + " | +" + (s.summary.additions ?? 0) + " -" + (s.summary.deletions ?? 0))
          }
          try { await ctx.reply(lines.join("\n")) } catch {}
        } catch (err) {
          const msg = handlePluginError(err, "/session")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
      })

      bot.command("rename", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        const sessionId = links[ctx.chat.id]
        if (!sessionId) {
          try { await ctx.reply("Not linked. Use /link <ID>") } catch {}
          return
        }
        const title = (ctx.payload || "").trim().slice(0, 200)
        if (!title) {
          try { await ctx.reply("Usage: /rename <new title>") } catch {}
          return
        }
        try {
          const res = await client.session.update({ path: { id: sessionId }, body: { title } })
          if (res.error) {
            try { await ctx.reply("Could not rename session.") } catch {}
            return
          }
          try { await ctx.reply("Renamed to: " + title.slice(0, 60)) } catch {}
        } catch (err) {
          const msg = handlePluginError(err, "/rename")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
      })

      bot.command("agents", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        try {
          const res = await client.app.agents()
          if (res.error || !res.data) {
            try { await ctx.reply("Could not load agents.") } catch {}
            return
          }
          const agents = Array.isArray(res.data) ? res.data : []
          if (agents.length === 0) {
            try { await ctx.reply("No agents available.") } catch {}
            return
          }
          const lines = ["Agents:"]
          for (const agent of agents) {
            const name = typeof agent.name === "string" ? agent.name : "?"
            const desc = typeof agent.description === "string" ? " - " + agent.description.slice(0, 80) : ""
            lines.push("  " + name + desc)
          }
          try { await ctx.reply(lines.join("\n")) } catch {}
        } catch (err) {
          const msg = handlePluginError(err, "/agents")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
      })

      bot.command("help", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        try {
          await ctx.reply(
            "/link <sessionId>     - Bind this chat to a session\n" +
            "/unlink               - Remove binding\n" +
            "/status               - Show connection state\n" +
            "/ls                   - List recent sessions\n" +
            "/use <number|ID>      - Switch active session\n" +
            "/model                - Show/set model override\n" +
            "/model clear          - Clear model override\n" +
            "/models               - List all available models\n" +
            "/agents               - List available agents\n" +
            "/session              - Show current session details\n" +
            "/rename <title>       - Rename current session\n" +
            "/history [N]          - View last N messages\n" +
            "/help                 - Show this help\n\n" +
            "Any other message will be sent to the linked session."
          )
        } catch {}
      })

      bot.on(["photo", "sticker", "document", "video", "audio", "voice"], async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        try {
          await ctx.reply("Only text messages are supported.")
        } catch {}
      })

      bot.on("text", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        const sessionId = links[ctx.chat.id]
        if (!sessionId) {
          try { await ctx.reply("Not linked. Use /link <ID>") } catch {}
          return
        }
        let working: any = null
        try {
          working = await ctx.reply("...")
        } catch (err) {
          debugLog("working reply failed:", userError(err))
        }
        setPending(sessionId, ctx.chat.id)
        try {
          const body: any = {
            parts: [{ type: "text", text: ctx.message.text, metadata: { opencodeTelegram: true } }],
          }
          const modelPref = sessionModelPrefs.get(sessionId)
          if (modelPref) {
            body.model = { providerID: modelPref.providerID, modelID: modelPref.modelID }
          }
          const res = await client.session.prompt({
            path: { id: sessionId },
            body,
            query: { directory },
          })
          if (res?.error) {
            const msg = handlePluginError(res.error, "prompt")
            try { await ctx.reply(sanitizeUI(msg)) } catch {}
          }
        } catch (err) {
          const msg = handlePluginError(err, "prompt")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
        clearPending(sessionId)
        if (working?.message_id) {
          try { await ctx.deleteMessage(working.message_id) } catch {}
        }
      })

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

      if (notifyOnReconnect) {
        for (const chatId of Object.keys(links)) {
          bot.telegram.sendMessage(Number(chatId), "Telegram bridge reconnected.").catch(() => {})
        }
      }
      bot.launch().catch(async (err) => {
        handlePluginError(err, "bot.launch")
        botReady = false
        try { await bot?.stop() } catch {}
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
            if (!botReady) {
              debugLog("chat.message: startBot did not reach ready state")
              return
            }
          }
        }
        if (!output || !Array.isArray(output.parts)) return
        for (const part of output.parts as any[]) {
          if (!part || part.type !== "text" || typeof part.text !== "string") continue
          let text = part.text
          if (text.length > MAX_TELEGRAM_INPUT) {
            text = text.slice(0, MAX_TELEGRAM_INPUT)
          }

          if (text.startsWith("/telegram")) {
            const rawArgs = text.slice("/telegram".length).trim().slice(0, 200)
            const cmd = rawArgs.toLowerCase()

            if (cmd === "disconnect" || cmd === "stop") {
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
              clearSavedToken()
              part.text = "Telegram bot disconnected and token removed."
              return
            }

            if (cmd === "status" || cmd === "") {
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
              part.text = sanitizeTUI(part.text, MAX_TUI_TEXT)
              return
            }

            const tokenMatch = rawArgs.match(/^\s*["'`]*([^\s"'`]+)["'`]*\s*$/)
            if (!tokenMatch) {
              part.text = sanitizeTUI("Invalid token.", MAX_TUI_TEXT)
              return
            }
            const token = tokenMatch[1]
            if (!isValidToken(token)) {
              part.text = sanitizeTUI("Invalid token.", MAX_TUI_TEXT)
              return
            }
            saveToken(token)
            await startBot(token)
            part.text = sanitizeTUI(botReady ? "Connected." : "Invalid token.", MAX_TUI_TEXT)
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
          if (typeof text !== "string" || text.length === 0) {
            return { output: "No text to send." }
          }
          if (!botReady) {
            return { output: "Telegram bot is not connected." }
          }
          if (!ctx?.sessionID && !sessionId) {
            return { output: "No session context." }
          }
          const targetId = sessionId || ctx.sessionID
          if (typeof targetId !== "string") {
            return { output: "Invalid session ID." }
          }
          const safeText = text.length > 4000 ? text.slice(0, 4000) + "..." : text
          const ok = await sendToSession(targetId, safeText)
          return { output: ok ? "Message sent to Telegram" : "No linked chats." }
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
      try { await bot?.stop() } catch {}
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
