import { type Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { Telegraf } from "telegraf"
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const LINK_FILE = join(homedir(), ".config", "opencode", "telegram-links.json")
const LINK_TMP = LINK_FILE + ".tmp"

function loadLinks(): Record<number, string> {
  try {
    if (existsSync(LINK_FILE)) {
      return JSON.parse(readFileSync(LINK_FILE, "utf-8"))
    }
  } catch {}
  return {}
}

function persistLinks(links: Record<number, string>) {
  mkdirSync(join(homedir(), ".config", "opencode"), { recursive: true })
  writeFileSync(LINK_TMP, JSON.stringify(links, null, 2))
  try {
    renameSync(LINK_TMP, LINK_FILE)
  } catch {
    writeFileSync(LINK_FILE, JSON.stringify(links, null, 2))
  }
}

function chunkText(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen))
  }
  return chunks
}

const TelegramPlugin: Plugin = async ({ client, directory }, options) => {
  console.log("[telegram-plugin] initializing")
  const config = options as
    | {
        allowed_users?: number[]
        token?: string
        notify_on_reconnect?: boolean
      }
    | undefined

  const token = config?.token || process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.warn("[telegram-plugin] TELEGRAM_BOT_TOKEN not set — disabled")
    return {}
  }

  console.log("[telegram-plugin] token found, creating bot")

  const allowedSet = config?.allowed_users?.length ? new Set(config.allowed_users) : null
  const notifyOnReconnect = config?.notify_on_reconnect ?? false
  const bot = new Telegraf(token)

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

  async function sendToSession(sessionId: string, text: string) {
    const chats = sessionToChats.get(sessionId)
    if (!chats) return
    const chunks = chunkText(text)
    for (const chatId of chats) {
      for (const chunk of chunks) {
        await bot.telegram.sendMessage(chatId, chunk).catch(() => {})
      }
    }
  }

  bot.command("link", async (ctx) => {
    if (allowedSet && !allowedSet.has(ctx.from.id)) return
    const sessionId = ctx.payload.trim()
    if (!sessionId) {
      await ctx.reply("Usage: /link <sessionId>")
      return
    }
    const res = await client.session.get({ path: { id: sessionId } })
    if (res.error) {
      await ctx.reply("Session not found: " + sessionId.slice(0, 12) + "...")
      return
    }
    addLink(ctx.chat.id, sessionId)
    await ctx.reply("Linked to session: " + sessionId.slice(0, 12) + "...")
  })

  bot.command("unlink", async (ctx) => {
    if (allowedSet && !allowedSet.has(ctx.from.id)) return
    if (!links[ctx.chat.id]) {
      await ctx.reply("No link found for this chat.")
      return
    }
    removeLink(ctx.chat.id)
    await ctx.reply("Unlinked from session.")
  })

  bot.command("status", async (ctx) => {
    if (allowedSet && !allowedSet.has(ctx.from.id)) return
    const sessionId = links[ctx.chat.id]
    if (!sessionId) {
      await ctx.reply("Not linked. Use /link <sessionId>")
      return
    }
    await ctx.reply(
      "Connected\nSession: " + sessionId.slice(0, 12) + "...\nProject: " + (directory || "unknown")
    )
  })

  bot.command("sessions", async (ctx) => {
    if (allowedSet && !allowedSet.has(ctx.from.id)) return
    const res = await client.session.list()
    if (res.error || !res.data) {
      await ctx.reply("Failed to list sessions.")
      return
    }
    const sessions = res.data
    const current = links[ctx.chat.id]
    const lines = sessions
      .slice(-10)
      .map((s) => {
        const marker = s.id === current ? " \u2705" : ""
        return s.id + marker
      })
    await ctx.reply("*Recent sessions:*\n" + (lines.length ? lines.join("\n") : "None"))
  })

  bot.command("help", async (ctx) => {
    if (allowedSet && !allowedSet.has(ctx.from.id)) return
    await ctx.reply(
      "/link <sessionId> - Bind this chat to a session\n" +
      "/unlink - Remove binding\n" +
      "/status - Show connection state\n" +
      "/sessions - List recent sessions\n" +
      "/help - Show this help\n\n" +
      "Any other message will be sent to the linked session."
    )
  })

  bot.on("text", async (ctx) => {
    if (allowedSet && !allowedSet.has(ctx.from.id)) return
    const sessionId = links[ctx.chat.id]
    if (!sessionId) {
      await ctx.reply("Not linked. Use /link <sessionId>")
      return
    }
    const working = await ctx.reply("\u23F3 Working...")
    const res = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: ctx.message.text, metadata: { opencodeTelegram: true } }],
      },
      query: { directory },
    })
    try { await ctx.deleteMessage(working.message_id) } catch {}
    if (res.error) {
      await ctx.reply("Error: " + String(res.error).slice(0, 200))
      return
    }
    const text = (res.data?.parts ?? [])
      .filter((p: any) => p.type === "text" && !p.synthetic)
      .map((p: any) => p.text)
      .join("\n")
    if (text) {
      for (const chunk of chunkText(text)) {
        await ctx.reply(chunk)
      }
    }
  })

  if (notifyOnReconnect) {
    for (const chatId of Object.keys(links)) {
      bot.telegram.sendMessage(Number(chatId), "OpenCode Telegram bridge reconnected.").catch(() => {})
    }
  }

  try {
    await Promise.race([
      bot.launch(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
    ])
    console.log("[telegram-plugin] bot connected")
  } catch (err) {
    console.warn("[telegram-plugin] bot failed to start:", err)
  }

  return {
    async event({ event }) {
      if (event.type === "session.error") {
        const sessionId = event.properties.sessionID
        if (sessionId) {
          const err = event.properties.error
          const msg = err && "data" in err ? String(err.data.message) : String(err ?? "Unknown")
          sendToSession(sessionId, "Error: " + msg.slice(0, 500))
        }
        return
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
      bot.stop()
    },
  }
}

export default {
  id: "@opencode-ai/plugin-telegram",
  server: TelegramPlugin,
}
