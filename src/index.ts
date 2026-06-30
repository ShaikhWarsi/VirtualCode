import { Telegraf } from "telegraf"
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

type PluginInput = {
  client: any
  project?: any
  directory: string
  worktree?: string
  [key: string]: any
}

type Plugin = (input: PluginInput, options?: any) => Promise<{
  event?: (input: { event: any }) => Promise<void>
  "chat.message"?: (input: any, output: any) => Promise<void>
  tool?: Record<string, any>
  dispose?: () => Promise<void>
}>

function getConfigDir(): string {
  const candidates: string[] = []
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, "opencode"))
    candidates.push(join(process.env.APPDATA, "kilo"))
  }
  candidates.push(
    join(homedir(), ".config", "opencode"),
    join(homedir(), ".opencode"),
    join(homedir(), ".config", "kilo"),
    join(homedir(), ".kilocode"),
  )
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return join(homedir(), ".config", "opencode")
}

function configPath(...parts: string[]): string {
  return join(getConfigDir(), ...parts)
}

const LINK_FILE = configPath("telegram-links.json")
const LINK_TMP = LINK_FILE + ".tmp"
const TOKEN_FILE = configPath("telegram-token.json")
const TOKEN_TMP = TOKEN_FILE + ".tmp"
const MODELS_FILE = configPath("telegram-models.json")
const MODELS_TMP = MODELS_FILE + ".tmp"
const AGENTS_FILE = configPath("telegram-agents.json")
const AGENTS_TMP = AGENTS_FILE + ".tmp"
const CONFIG_DIR = getConfigDir()
const LOG_FILE = join(CONFIG_DIR, "telegram-plugin.log")
const LOG_FILE_OLD = LOG_FILE + ".1"
const MAX_LOG_SIZE = 5 * 1024 * 1024

const TOKEN_REGEX = /^\d{8,12}:[\w-]{30,50}$/
const MAX_LRU_SIZE = 100
const PENDING_TIMEOUT_MS = 120_000
const RECONNECT_DELAYS = [5_000, 10_000, 20_000, 30_000]
const MAX_TELEGRAM_INPUT = 4096
const MAX_TUI_TEXT = 400
const MIN_PREFIX_LEN = 4
const MAX_TOKENS_PER_CHUNK = 25
const MIN_HISTORY_LIMIT = 1
const FILE_MODE = 0o600
const SHORT_ID_LEN = 5
const MAX_TITLE_LEN = 200
const MAX_DIR_LEN = 200

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

const sessionAgentPrefs = new Map<string, string>()

function loadAgentPrefs(): Map<string, string> {
  const m = new Map<string, string>()
  try {
    if (existsSync(AGENTS_FILE)) {
      const raw = readFileSync(AGENTS_FILE, "utf-8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [sid, agent] of Object.entries(parsed)) {
          if (typeof agent === "string") m.set(sid, agent)
        }
      }
    }
  } catch (err) {
    debugLog("loadAgentPrefs failed:", userError(err))
  }
  return m
}

function persistAgentPrefs() {
  const obj: Record<string, string> = {}
  for (const [sid, agent] of sessionAgentPrefs) {
    obj[sid] = agent
  }
  atomicWrite(AGENTS_FILE, AGENTS_TMP, JSON.stringify(obj, null, 2))
}

function setAgentPref(sessionId: string, agent: string) {
  sessionAgentPrefs.set(sessionId, agent)
  persistAgentPrefs()
}

function clearAgentPref(sessionId: string) {
  sessionAgentPrefs.delete(sessionId)
  persistAgentPrefs()
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
  if (!text) return []
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen))
  }
  return chunks
}

function fmtId(id: string): string {
  if (typeof id !== "string") return "(invalid)"
  const stripped = id.startsWith("ses_") ? id.slice(4) : id
  return stripped.length > SHORT_ID_LEN ? stripped.slice(0, SHORT_ID_LEN) + "..." : stripped
}

type FindResult =
  | { status: "found"; session: any }
  | { status: "ambiguous" }
  | { status: "not_found" }

function findSessionById(input: string, list: any[]): FindResult {
  if (typeof input !== "string" || !Array.isArray(list)) return { status: "not_found" }
  const exact = list.find((s: any) => s && typeof s.id === "string" && s.id === input)
  if (exact) return { status: "found", session: exact }
  if (input.length < MIN_PREFIX_LEN) return { status: "not_found" }
  const fullPrefix = list.filter((s: any) => s && typeof s.id === "string" && s.id.startsWith(input))
  if (fullPrefix.length === 1) return { status: "found", session: fullPrefix[0] }
  if (fullPrefix.length > 1) return { status: "ambiguous" }
  const strippedPrefix = list.filter((s: any) => {
    if (typeof s.id !== "string") return false
    const stripped = s.id.startsWith("ses_") ? s.id.slice(4) : s.id
    return stripped.startsWith(input)
  })
  if (strippedPrefix.length === 1) return { status: "found", session: strippedPrefix[0] }
  if (strippedPrefix.length > 1) return { status: "ambiguous" }
  return { status: "not_found" }
}

function safeList(arr: any[]): any[] {
  if (!Array.isArray(arr)) return []
  return arr.filter((s) => s && typeof s === "object" && typeof s.id === "string")
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

async function loadTool() {
  for (const pkg of ["@kilocode/plugin/tool", "@opencode-ai/plugin/tool"]) {
    try {
      const mod = await import(pkg)
      if (mod?.tool) return mod.tool
    } catch {}
  }
  return null
}

const TelegramPlugin: Plugin = async ({ client, directory }, options) => {
  const tool = await loadTool()
  if (!tool) fileLog("WARN", "No plugin SDK found – tool unavailable (install @opencode-ai/plugin or @kilocode/plugin)")
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
  let startCheckTimer: ReturnType<typeof setInterval> | null = null

  const lastForwardedBySession = new Map<string, string>()
  const pendingTelegram = new Map<string, { chatId: number; timer: ReturnType<typeof setTimeout>; messageId?: number }>()

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

  const savedAgentPrefs = loadAgentPrefs()
  for (const [sid, agent] of savedAgentPrefs) {
    sessionAgentPrefs.set(sid, agent)
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

  function setPending(sessionId: string, chatId: number, messageId?: number) {
    const existing = pendingTelegram.get(sessionId)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      pendingTelegram.delete(sessionId)
      if (botReady && bot) {
        if (messageId) {
          bot.telegram.editMessageText(chatId, messageId, undefined, "No response received. The session may not be active on your laptop - open it there first.").catch(() => {})
        } else {
          bot.telegram.sendMessage(chatId, "No response received. The session may not be active on your laptop - open it there first.").catch(() => {})
        }
      }
    }, PENDING_TIMEOUT_MS)
    pendingTelegram.set(sessionId, { chatId, timer, messageId })
  }

  function clearPending(sessionId: string) {
    const entry = pendingTelegram.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      pendingTelegram.delete(sessionId)
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    if (userStopped) {
      const newToken = loadSavedToken()
      if (newToken) {
        userStopped = false
        savedToken = newToken
      } else {
        return
      }
    }
    if (!savedToken) return
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

  function startStartCheck() {
    if (startCheckTimer) return
    startCheckTimer = setInterval(async () => {
      if (botReady || botStarting || userStopped) return
      const saved = loadSavedToken()
      if (saved) {
        debugLog("start check: found saved token, starting bot")
        await startBot(saved)
      }
    }, 5000)
  }

  function stopStartCheck() {
    if (startCheckTimer) {
      clearInterval(startCheckTimer)
      startCheckTimer = null
    }
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
            "virtualcode - Telegram bridge\n\n" +
            "Quick setup:\n" +
            "1. /ls - list your sessions (shows abbreviated IDs)\n" +
            "2. /link <ID> - bind this chat (type the short ID, e.g. a1b2c)\n" +
            "3. Send any message to talk to your AI assistant\n\n" +
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
            try { await ctx.reply("Linked to " + ((result.session.title || "").slice(0, MAX_TITLE_LEN) || fmtId(result.session.id))) } catch {}
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
            "Connected | Session: " + fmtId(sessionId) + " | Project: " + ((directory || "none").slice(0, MAX_DIR_LEN))
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
            const label = (s.title || fmtId(s.id)).slice(0, 60)
            return num + ". " + label + " -- " + fmtId(s.id) + marker
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
            try { await ctx.reply("Switched to " + ((s.title || "").slice(0, MAX_TITLE_LEN) || fmtId(s.id))) } catch {}
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
          try { await ctx.reply("Switched to " + ((result.session.title || "").slice(0, MAX_TITLE_LEN) || fmtId(result.session.id))) } catch {}
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
              try { await ctx.reply("Model set to " + providerID + "/" + match + " (" + modelName.slice(0, MAX_TITLE_LEN) + ")") } catch {}
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
            const text = lines.join("\n")
            for (const chunk of chunkText(text)) {
              try { await ctx.reply(chunk) } catch {}
            }
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
            "Title: " + ((s.title || "(untitled)").slice(0, MAX_TITLE_LEN)),
            "ID: " + fmtId(s.id),
            "Project: " + ((s.directory || "none").slice(0, MAX_DIR_LEN)),
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
          const text = lines.join("\n")
          for (const chunk of chunkText(text)) {
            try { await ctx.reply(chunk) } catch {}
          }
        } catch (err) {
          const msg = handlePluginError(err, "/agents")
          try { await ctx.reply(sanitizeUI(msg)) } catch {}
        }
      })

      bot.command("agent", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        const sessionId = links[ctx.chat.id]
        if (!sessionId) {
          try { await ctx.reply("Not linked. Use /link <ID>") } catch {}
          return
        }
        const arg = (ctx.payload || "").trim().slice(0, 200)

        if (!arg) {
          const current = sessionAgentPrefs.get(sessionId)
          if (current) {
            try { await ctx.reply("Agent: " + current) } catch {}
          } else {
            try { await ctx.reply("No agent override set. Send /agents to see available agents, or /agent <name> to set one.") } catch {}
          }
          return
        }

        setAgentPref(sessionId, arg)
        try { await ctx.reply("Agent set to " + arg.slice(0, MAX_TITLE_LEN)) } catch {}
      })

      bot.command("help", async (ctx) => {
        if (allowedSet && (!ctx.from || !allowedSet.has(ctx.from.id))) return
        try {
          await ctx.reply(
            "/link <ID>            - Bind this chat to a session (short ID, e.g. a1b2c)\n" +
            "/unlink               - Remove binding\n" +
            "/status               - Show connection state\n" +
            "/ls                   - List recent sessions (shows short IDs)\n" +
            "/use <N|ID>           - Switch session (by number or short ID)\n" +
            "/model                - Show/set model override\n" +
            "/models               - List all available models\n" +
            "/agent                - Show/set agent override\n" +
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
        let workingMsgId: number | undefined
        try {
          const working = await ctx.reply("...")
          workingMsgId = working.message_id
        } catch (err) {
          debugLog("working reply failed:", userError(err))
        }
        setPending(sessionId, ctx.chat.id, workingMsgId)
        try {
          const body: any = {
            parts: [{ type: "text", text: ctx.message.text, metadata: { opencodeTelegram: true } }],
          }
          const modelPref = sessionModelPrefs.get(sessionId)
          if (modelPref) {
            body.model = { providerID: modelPref.providerID, modelID: modelPref.modelID }
          }
          const agentPref = sessionAgentPrefs.get(sessionId)
          if (agentPref) {
            body.agent = agentPref
          }
          const res = await client.session.prompt({
            path: { id: sessionId },
            body,
            query: { directory },
          })
          if (res?.error) {
            const msg = handlePluginError(res.error, "prompt")
            const pending = pendingTelegram.get(sessionId)
            if (pending && pending.messageId && bot) {
              bot.telegram.editMessageText(ctx.chat.id, pending.messageId, undefined, sanitizeUI(msg, 4000)).catch(() => {
                try { ctx.reply(sanitizeUI(msg)) } catch {}
              })
            } else {
              try { await ctx.reply(sanitizeUI(msg)) } catch {}
            }
          }
        } catch (err) {
          const msg = handlePluginError(err, "prompt")
          const pending = pendingTelegram.get(sessionId)
          if (pending && pending.messageId && bot) {
            bot.telegram.editMessageText(ctx.chat.id, pending.messageId, undefined, sanitizeUI(msg, 4000)).catch(() => {
              try { ctx.reply(sanitizeUI(msg)) } catch {}
            })
          } else {
            try { await ctx.reply(sanitizeUI(msg)) } catch {}
          }
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
      stopStartCheck()

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
  startStartCheck()

  return {
    async event({ event }) {
      try {
        if (event.type === "session.error") {
          const sessionId = event.properties.sessionID
          if (sessionId) {
            const err = event.properties.error
            const msg = handlePluginError(err, "session.error")
            if (botReady) {
              await sendToSession(sessionId, msg)
            } else {
              debugLog("session.error (bot not ready):", msg)
            }
          }
          return
        }
        if (!botReady) return
        if (event.type === "session.status") {
          const sid = event.properties.sessionID

          if (event.properties.status?.type === "idle") {
            const pending = pendingTelegram.get(sid)
            const chats = pending ? new Set([pending.chatId]) : sessionToChats.get(sid)
            if (!chats || chats.size === 0) return
            let msgs
            try {
              msgs = await client.session.messages({ path: { id: sid }, query: { directory, limit: 5 } })
            } catch { return }
            if (msgs.error || !msgs.data) return
            const last = [...msgs.data].reverse().find((m: any) => m.info.role === "assistant")
            if (!last || !last.info?.id || lastForwardedBySession.get(sid) === last.info.id) return
            lruSet(lastForwardedBySession, sid, last.info.id)
            const text = (last.parts as any[])
              .filter((p: any) => p.type === "text" && !p.synthetic)
              .map((p: any) => p.text)
              .join("\n")
            if (text) {
              if (pending?.messageId && bot) {
                const chunks = chunkText(text, 4000)
                bot.telegram.editMessageText(pending.chatId, pending.messageId, undefined, chunks[0]).catch(() => {
                  sendToChats(chats, text)
                })
                clearTimeout(pending.timer)
                pendingTelegram.delete(sid)
                for (const chunk of chunks.slice(1)) {
                  bot.telegram.sendMessage(pending.chatId, chunk).catch(() => {})
                }
              } else {
                sendToChats(chats, text)
              }
            }
          }
        }
      } catch (err) {
        debugLog("event handler:", userError(err))
      }
    },

    "chat.message": async (_input, output) => {
      try {
        if (!output || !Array.isArray(output.parts)) return
        const remaining: any[] = []
        for (const part of output.parts as any[]) {
          if (!part || part.type !== "text" || typeof part.text !== "string") {
            remaining.push(part)
            continue
          }
          const text = part.text
          if (text.length > MAX_TELEGRAM_INPUT || !text.startsWith("/telegram")) {
            remaining.push(part)
            continue
          }

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
            continue
          }

          if (cmd === "status" || cmd === "") continue

          const tokenMatch = rawArgs.match(/^\s*["'`]*([^\s"'`]+)["'`]*\s*$/)
          if (!tokenMatch) continue
          const token = tokenMatch[1]
          if (!isValidToken(token)) continue

          if (!botReady && !botStarting) {
            const configToken = config?.token
            const envToken = process.env.TELEGRAM_BOT_TOKEN
            const fileToken = loadSavedToken()
            const saved = configToken || envToken || fileToken
            if (saved) {
              reconnectAttempts = 0
              await startBot(saved)
            }
          }

          await startBot(token)
          if (botReady) {
            saveToken(token)
          }
        }
        output.parts = remaining
      } catch (err) {
        debugLog("chat.message:", userError(err))
      }
    },

    ...(tool ? {
      tool: {
        telegram_send: (tool as NonNullable<typeof tool>)({
          description: "Send a message to Telegram chat(s) linked to the current session",
          args: {
            text: (tool as NonNullable<typeof tool>).schema.string().describe("Text to send"),
            sessionId: (tool as NonNullable<typeof tool>).schema.string().optional().describe("Target session ID (defaults to current)"),
          },
          async execute({ text, sessionId }: { text: string; sessionId?: string }, ctx: any) {
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
    } : {}),

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
      stopStartCheck()
    },
  }
}

export default {
  id: "virtualcode",
  server: TelegramPlugin,
}
