import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname, delimiter } from "node:path"
import { homedir } from "node:os"

function hasCommand(cmd) {
  const isWin = process.platform === "win32"
  const pathExt = isWin ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""]
  const pathDirs = (process.env.PATH || "").split(delimiter)
  for (const dir of pathDirs) {
    for (const ext of pathExt) {
      if (existsSync(join(dir, cmd + ext))) return true
    }
  }
  return false
}

function configDirs(name) {
  const dirs = [join(homedir(), ".config", name)]
  const appdata = process.env.APPDATA
  if (appdata) dirs.push(join(appdata, name))
  dirs.push(join(homedir(), "." + name))
  return dirs
}

const TOOLS = [
  {
    id: "opencode",
    label: "OpenCode",
    dirs: configDirs("opencode"),
    bin: "opencode",
    configs: [
      { file: "opencode.jsonc" },
      { file: "opencode.json" },
    ],
    tui: { file: "tui.json" },
  },
  {
    id: "kilo",
    label: "Kilo Code",
    dirs: configDirs("kilo"),
    bin: "kilo",
    configs: [
      { file: "kilo.jsonc" },
    ],
    tui: { file: "tui.json" },
  },
]

function detectTools() {
  return TOOLS.filter((t) => t.dirs.some((d) => existsSync(d)) || hasCommand(t.bin))
}

function findToolDir(tool) {
  return tool.dirs.find((d) => existsSync(d)) || tool.dirs[0]
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

const ENTRIES = ["virtualcode", "virtualcode/tui"]

function removeFromPluginArray(config) {
  if (!Array.isArray(config.plugin)) return false
  const before = config.plugin.length
  config.plugin = config.plugin.filter((e) => !ENTRIES.includes(e))
  return config.plugin.length !== before
}

function tryRemoveConfig(filename, targetDir) {
  const searchNames = [
    join(".opencode", filename),
    join(".kilocode", filename),
    filename,
  ]
  const path = findConfig(process.cwd(), searchNames) || join(targetDir, filename)
  if (!existsSync(path)) return
  let raw
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return
  }
  let config
  try {
    config = JSON.parse(stripJsonc(raw))
  } catch {
    return
  }
  if (!removeFromPluginArray(config)) return
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
  console.log("[virtualcode] Removed from " + path)
}

const detected = detectTools()
for (const tool of detected) {
  const targetDir = findToolDir(tool)
  for (const cfg of tool.configs) {
    tryRemoveConfig(cfg.file, targetDir)
  }
  if (tool.tui) {
    tryRemoveConfig(tool.tui.file, targetDir)
  }
}
