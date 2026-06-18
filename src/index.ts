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

  const allowedSet = config?.allowed_users?.length ? new Set(config.allowed_users) : null
  const notifyOnReconnect = config?.notify_on_reconnect ?? false

  let bot: Telegraf | null = null
  let botReady = false
  let mcpCleanup: (() => void) | null = null
  let expectingToken = false

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
    if (!botReady) return
    const chats = sessionToChats.get(sessionId)
    if (!chats) return
    const chunks = chunkText(text)
    for (const chatId of chats) {
      for (const chunk of chunks) {
        await bot!.telegram.sendMessage(chatId, chunk).catch(() => {})
      }
    }
  }

  async function startBot(token: string) {
    try {
      bot = new Telegraf(token)

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

      await Promise.race([
        bot.launch(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
      ])
      botReady = true
      console.log("[telegram-plugin] bot connected")
    } catch (err) {
      console.warn("[telegram-plugin] bot failed to start:", err)
    }
  }

  async function setupMcpServer() {
    try {
      const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js")
      const { WebStandardStreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
      )

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      })

      const mcpServer = new McpServer({
        name: "@opencode-ai/plugin-telegram",
        version: "1.0.0",
      }, {
        capabilities: { prompts: {} },
      })

      mcpServer.prompt("telegram", "Configure Telegram integration", async () => {
        expectingToken = true
        setTimeout(() => { expectingToken = false }, 120_000)
        return {
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: botReady
                ? "Telegram bot is connected. Show the user the status."
                : "The user wants to set up Telegram. Guide them through the setup wizard. " +
                  "Ask them to paste their BotFather token. When they do, the plugin will " +
                  "automatically intercept it and connect the bot.",
            },
          }],
        }
      })

      mcpServer.prompt("telegram-status", "Show Telegram connection status", async () => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: botReady
              ? "Telegram bot is connected and running. The user can use /link in Telegram."
              : "Telegram bot is not configured yet. Type /telegram to set it up.",
          },
        }],
      }))

      await mcpServer.connect(transport)

      let mcpPort: number
      let mcpUrl: string
      let closeServer: () => void

      if (typeof Bun !== "undefined") {
        const bunServer = Bun.serve({
          port: 0,
          fetch: (req: Request) => transport.handleRequest(req),
        })
        mcpPort = bunServer.port!
        mcpUrl = `http://localhost:${mcpPort}`
        closeServer = () => bunServer.stop()
      } else {
        const http = await import("node:http")
        const nodeServer = http.createServer(async (nodeReq, nodeRes) => {
          try {
            const protocol = nodeReq.headers["x-forwarded-proto"]?.[0] === "https" ? "https" : "http"
            const host = nodeReq.headers.host || "localhost"
            const url = new URL(nodeReq.url || "/", `${protocol}://${host}`)

            let body: string | undefined
            if (nodeReq.method !== "GET" && nodeReq.method !== "DELETE") {
              body = await new Promise<string>((resolve) => {
                let data = ""
                nodeReq.on("data", (chunk: Buffer) => data += chunk.toString())
                nodeReq.on("end", () => resolve(data))
              })
            }

            const headers = new Headers()
            for (const [key, value] of Object.entries(nodeReq.headers)) {
              if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value)
            }

            const request = new Request(url.toString(), {
              method: nodeReq.method ?? "GET",
              headers,
              body: body ?? null,
            })

            const response = await transport.handleRequest(request)
            nodeRes.statusCode = response.status
            response.headers.forEach((value, key) => nodeRes.setHeader(key, value))
            if (response.body) {
              const reader = response.body.getReader()
              const pump = () => reader.read().then(({ done, value }) => {
                if (done) nodeRes.end()
                else { nodeRes.write(value); pump() }
              })
              pump()
            } else {
              nodeRes.end()
            }
          } catch (err) {
            nodeRes.statusCode = 500
            nodeRes.end("Internal Server Error")
          }
        })
        await new Promise<void>((resolve) => nodeServer.listen(0, resolve))
        const addr = nodeServer.address() as { port: number }
        mcpPort = addr.port
        mcpUrl = `http://localhost:${mcpPort}`
        closeServer = () => nodeServer.close()
      }

      const addResult = await client.mcp.add({
        body: { name: "opencode-telegram", config: { type: "remote" as const, url: mcpUrl } },
        query: { directory },
      })

      mcpCleanup = () => {
        closeServer()
        mcpServer.close().catch(() => {})
        client.mcp.disconnect({ path: { name: "opencode-telegram" }, query: { directory } }).catch(() => {})
      }

      console.log(`[telegram-plugin] MCP server running on ${mcpUrl}`)
    } catch (err) {
      console.warn("[telegram-plugin] MCP server setup failed:", err)
    }
  }

  const existingToken = config?.token || process.env.TELEGRAM_BOT_TOKEN || loadSavedToken()
  if (existingToken) {
    console.log("[telegram-plugin] token found, creating bot")
    await startBot(existingToken)
  } else {
    console.log("[telegram-plugin] no token found — type /telegram in OpenCode to set up")
  }

  setupMcpServer()

  return {
    async event({ event }) {
      if (!botReady) return
      if (event.type === "session.error") {
        const sessionId = event.properties.sessionID
        if (sessionId) {
          const err = event.properties.error
          const msg = err && "data" in err ? String(err.data.message) : String(err ?? "Unknown")
          sendToSession(sessionId, "Error: " + msg.slice(0, 500))
        }
      }
    },

    "chat.message": async (_input, output) => {
      if (!botReady && !expectingToken) {
        const saved = loadSavedToken()
        if (saved) {
          console.log("[telegram-plugin] token found from TUI setup, connecting...")
          await startBot(saved)
        }
      }
      for (const part of output.parts as any[]) {
        if (part.type !== "text") continue
        const text = part.text

        if (expectingToken && !botReady) {
          const token = text.trim()
          expectingToken = false
          if (token.length > 20 && /^\d+:[\w-]+$/.test(token)) {
            client.tui.showToast({
              body: { title: "Telegram", message: "Connecting...", variant: "info" },
              query: { directory },
            }).catch(() => {})
            saveToken(token)
            await startBot(token)
            if (botReady) {
              client.tui.showToast({
                body: { title: "Telegram", message: "Bot connected!", variant: "success", duration: 3000 },
                query: { directory },
              }).catch(() => {})
              part.text = "\u2705 Telegram bot connected successfully! Use /help in the Telegram bot for commands."
            } else {
              part.text = "\u274c Invalid token. Try again with /telegram"
            }
            return
          }
        }

        if (text.startsWith("/telegram")) {
          const token = text.slice("/telegram".length).trim()
          if (!token) {
            part.text = botReady
              ? "Telegram bot is already connected. Status: connected."
              : "The user ran /telegram to set up Telegram. Guide them through the setup."
            return
          }
          expectingToken = false
          client.tui.showToast({
            body: { title: "Telegram", message: "Connecting...", variant: "info" },
            query: { directory },
          }).catch(() => {})
          saveToken(token)
          await startBot(token)
          if (botReady) {
            client.tui.showToast({
              body: { title: "Telegram", message: "Bot connected!", variant: "success", duration: 3000 },
              query: { directory },
            }).catch(() => {})
          }
          part.text = botReady
            ? "\u2705 Telegram bot connected!"
            : "\u274c Invalid token. Check the token from @BotFather and try again."
          return
        }
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
      bot?.stop()
      mcpCleanup?.()
    },
  }
}

export default {
  id: "@opencode-ai/plugin-telegram",
  server: TelegramPlugin,
}
