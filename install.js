import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

const XDG_CONFIG = join(homedir(), ".config", "opencode")

function findConfig(start, name) {
  const candidates = [
    join(start, ".opencode", name),
    join(start, name),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  const parent = dirname(start)
  if (parent !== start) return findConfig(parent, name)
  return null
}

function addToConfig(filename) {
  const path = findConfig(process.cwd(), filename) || join(XDG_CONFIG, filename)
  let config = { plugin: [] }
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf-8"))
    } catch {
      config = { plugin: [] }
    }
  }
  if (!Array.isArray(config.plugin)) config.plugin = []
  if (config.plugin.includes("virtualcode")) return
  config.plugin.unshift("virtualcode")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
  console.log("[virtualcode] Added to " + path)
}

addToConfig("opencode.jsonc")
addToConfig("opencode.json")
addToConfig("tui.json")
