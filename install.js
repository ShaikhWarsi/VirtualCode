import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

const CONFIG_DIRS = [
  join(homedir(), ".config", "opencode"),
  join(homedir(), ".config", "kilo"),
]

function findConfig(start, name) {
  const candidates = [
    join(start, ".opencode", name),
    join(start, ".kilocode", name),
    join(start, name),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  const parent = dirname(start)
  if (parent !== start) return findConfig(parent, name)
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
  const path = findConfig(process.cwd(), filename) || join(targetDir, filename)
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

tryAddConfig("opencode.jsonc", (raw) => JSON.parse(stripJsonc(raw)), CONFIG_DIRS[0])
tryAddConfig("opencode.json", (raw) => JSON.parse(raw), CONFIG_DIRS[0])
tryAddConfig("kilo.jsonc", (raw) => JSON.parse(stripJsonc(raw)), CONFIG_DIRS[1])
tryAddConfig("tui.json", (raw) => JSON.parse(stripJsonc(raw)), CONFIG_DIRS[0])
