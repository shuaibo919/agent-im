import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

interface ClaudeSettings {
  mcpServers?: Record<string, { url?: string; command?: string; args?: string[] }>
  [key: string]: unknown
}

const DEFAULT_URL = 'http://localhost:8787/mcp'
const MCP_NAME = 'agent-im'

function parseArgs(args: string[]) {
  const opts = {
    project: false,
    remove: false,
    url: DEFAULT_URL,
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') opts.project = true
    else if (args[i] === '--remove') opts.remove = true
    else if (args[i] === '--url' && args[i + 1]) opts.url = args[++i]
  }
  return opts
}

function getSettingsPath(project: boolean): string {
  if (project) {
    return path.join(process.cwd(), '.claude', 'settings.json')
  }
  return path.join(os.homedir(), '.claude', 'settings.json')
}

function readSettings(filePath: string): ClaudeSettings {
  if (!fs.existsSync(filePath)) return {}
  const raw = fs.readFileSync(filePath, 'utf-8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Invalid JSON in ${filePath}. Please fix it manually.`)
  }
}

function writeSettings(filePath: string, settings: ClaudeSettings): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
}

export function configure(args: string[] = []) {
  const opts = parseArgs(args)
  const settingsPath = getSettingsPath(opts.project)
  const settings = readSettings(settingsPath)

  if (opts.remove) {
    if (settings.mcpServers?.[MCP_NAME]) {
      delete settings.mcpServers[MCP_NAME]
      writeSettings(settingsPath, settings)
      console.log(`Removed "${MCP_NAME}" from ${settingsPath}`)
    } else {
      console.log(`"${MCP_NAME}" not found in ${settingsPath}`)
    }
    return
  }

  settings.mcpServers = settings.mcpServers ?? {}
  settings.mcpServers[MCP_NAME] = { url: opts.url }
  writeSettings(settingsPath, settings)
  console.log(`Configured "${MCP_NAME}" in ${settingsPath}`)
  console.log(`  MCP URL: ${opts.url}`)
}

// Run directly
const args = process.argv.slice(2)
configure(args)
