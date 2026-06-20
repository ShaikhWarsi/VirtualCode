import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

function hasCommand(cmd) {
  const isWin = process.platform === "win32"
  const pathExt = isWin ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""]
  const pathDirs = (process.env.PATH || "").split(require("path").delimiter)
  for (const dir of pathDirs) {
    for (const ext of pathExt) {
      if (existsSync(join(dir, cmd + ext))) return true
    }
  }
  return false
}

const TOOLS = [
  {
    id: "opencode",
    label: "OpenCode",
    configDir: join(homedir(), ".config", "opencode"),
    bin: "opencode",
    configs: [
      { file: "opencode.jsonc", json: false, stripJsonc: true },
      { file: "opencode.json", json: true, stripJsonc: false },
    ],
    tui: { file: "tui.json", json: false, stripJsonc: true },
  },
  {
    id: "kilo",
    label: "Kilo Code",
    configDir: join(homedir(), ".config", "kilo"),
    bin: "kilo",
    configs: [
      { file: "kilo.jsonc", json: false, stripJsonc: true },
    ],
  },
]

function detectTools() {
  return TOOLS.filter((t) => existsSync(t.configDir) || hasCommand(t.bin))
}

function findConfig(start, names) {
  for (const name of names) {
    const p = join(start, name)
    if (existsSync(p)) return p
  }
  const parent = dirname(start)
  if (parent !== start) return findConfig(parent, names)
  return null
}

function stripJsonc(src) {
  let out = ""
  let i = 0
  let inString = false
  let stringChar = ""
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (inString) {
      out += c
      if (c === "\\" && i + 1 < src.length) {
        out += next
        i += 2
        continue
      }
      if (c === stringChar) inString = false
      i++
      continue
    }
    if (c === '"' || c === "'") {
      inString = true
      stringChar = c
      out += c
      i++
      continue
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function tryAddConfig(filename, parser, targetDir) {
  const searchNames = [
    join(".opencode", filename),
    join(".kilocode", filename),
    filename,
  ]
  const path = findConfig(process.cwd(), searchNames) || join(targetDir, filename)
  let raw = ""
  let config = { plugin: [] }
  if (existsSync(path)) {
    try {
      raw = readFileSync(path, "utf-8")
      config = parser(raw)
    } catch {
      config = { plugin: [] }
    }
  }
  if (!Array.isArray(config.plugin)) config.plugin = []
  if (config.plugin.includes("virtualcode")) return
  config.plugin.unshift("virtualcode")
  mkdirSync(dirname(path), { recursive: true })
  const serialized = JSON.stringify(config, null, 2)
  if (raw && filename.endsWith("jsonc")) {
    const lines = raw.split("\n")
    const pluginLineIdx = lines.findIndex((l) => /^\s*"plugin"\s*:/.test(l))
    if (pluginLineIdx !== -1) {
      const indent = (lines[pluginLineIdx].match(/^\s*/) || [""])[0]
      const newLines = serialized.split("\n")
      const newPluginBlock = newLines.find((l) => /^\s*"plugin"\s*:/.test(l))
      if (newPluginBlock) {
        const entryIndent = indent + "  "
        const pluginEntries = config.plugin.map((p) => entryIndent + JSON.stringify(p))
        const replacement = indent + '"plugin": [\n' + pluginEntries.join(",\n") + "\n" + indent + "]"
        lines[pluginLineIdx] = replacement
        writeFileSync(path, lines.join("\n") + "\n")
        console.log("[virtualcode] Added to " + path + " (comments preserved)")
        return
      }
    }
  }
  writeFileSync(path, serialized + "\n")
  console.log("[virtualcode] Added to " + path)
}

function installForTool(tool) {
  const targetDir = tool.configDir
  for (const cfg of tool.configs) {
    const parser = cfg.stripJsonc ? (raw) => JSON.parse(stripJsonc(raw)) : (raw) => JSON.parse(raw)
    tryAddConfig(cfg.file, parser, targetDir)
  }
  if (tool.tui) {
    const parser = tool.tui.stripJsonc ? (raw) => JSON.parse(stripJsonc(raw)) : (raw) => JSON.parse(raw)
    tryAddConfig(tool.tui.file, parser, targetDir)
  }
}

const detected = detectTools()

if (detected.length === 0) {
  console.log("[virtualcode] No supported AI coding tool found (OpenCode, Kilo Code).")
  console.log("[virtualcode] To use this plugin, install OpenCode or Kilo Code first.")
  console.log("[virtualcode] You can also manually add 'virtualcode' to your config's plugin array.")
} else {
  for (const tool of detected) {
    console.log("[virtualcode] Detected " + tool.label + " – installing...")
    installForTool(tool)
  }
}
