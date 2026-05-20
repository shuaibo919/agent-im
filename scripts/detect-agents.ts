import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

interface ModelEntry {
  label: string
  value: string
  active?: boolean
}

interface DetectedAgent {
  id: string
  name: string
  exe_path: string | null
  config_dir: string | null
  models: ModelEntry[]
}

// --- Config readers ---

function readClaudeModels(configDir: string): ModelEntry[] {
  const models: ModelEntry[] = []
  const settingsPath = path.join(configDir, 'settings.json')
  if (!fs.existsSync(settingsPath)) return models

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const env = settings.env || {}

    // Primary model
    const primary = env.ANTHROPIC_MODEL
    if (primary) models.push({ label: primary, value: primary, active: true })

    // Collect all unique model values from env
    const modelKeys = [
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_FAST_MODEL',
    ]
    for (const key of modelKeys) {
      const val = env[key]
      if (val && !models.some(m => m.value === val)) {
        models.push({ label: `${val} (${key.replace('ANTHROPIC_DEFAULT_', '').replace('_MODEL', '').toLowerCase()})`, value: val })
      }
    }
  } catch { /* ignore parse errors */ }

  // If no models found from config, add known defaults
  if (models.length === 0) {
    models.push(
      { label: 'claude-opus-4-6', value: 'claude-opus-4-6' },
      { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5-20251001' },
    )
  }

  return models
}

function readCodexModels(configDir: string): ModelEntry[] {
  const models: ModelEntry[] = []
  const configPath = path.join(configDir, 'config.toml')
  if (!fs.existsSync(configPath)) return models

  try {
    const content = fs.readFileSync(configPath, 'utf-8')

    // Parse model = "xxx" from TOML (top-level)
    const modelMatch = content.match(/^model\s*=\s*"([^"]+)"/m)
    if (modelMatch) {
      models.push({ label: modelMatch[1], value: modelMatch[1], active: true })
    }

    // Parse model_providers sections for additional model names
    const providerModels = content.matchAll(/\[model_providers\.([^\]]+)\][^[]*?/g)
    for (const pm of providerModels) {
      const section = pm[0]
      const nameMatch = section.match(/name\s*=\s*"([^"]+)"/)
      if (nameMatch && !models.some(m => m.value === nameMatch[1])) {
        models.push({ label: nameMatch[1], value: nameMatch[1] })
      }
    }

    // Check tui.model_availability_nux for additional models
    const nuxModels = content.matchAll(/\[tui\.model_availability_nux\][^[]*?"([^"]+)"\s*=\s*\d+/g)
    for (const nm of nuxModels) {
      if (!models.some(m => m.value === nm[1])) {
        models.push({ label: nm[1], value: nm[1] })
      }
    }
  } catch { /* ignore parse errors */ }

  if (models.length === 0) {
    models.push(
      { label: 'o4-mini', value: 'o4-mini' },
      { label: 'o3', value: 'o3' },
    )
  }

  return models
}

function readGeminiModels(configDir: string): ModelEntry[] {
  const models: ModelEntry[] = []

  // Check .env for model
  const envPath = path.join(configDir, '.env')
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8')
      const modelMatch = content.match(/GEMINI_MODEL\s*=\s*(.+)/m)
      if (modelMatch) {
        const val = modelMatch[1].trim().replace(/^["']|["']$/g, '')
        models.push({ label: val, value: val, active: true })
      }
    } catch { /* ignore */ }
  }

  // Check settings.json
  const settingsPath = path.join(configDir, 'settings.json')
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      const model = settings.model || settings.defaultModel
      if (model && !models.some(m => m.value === model)) {
        models.push({ label: model, value: model, active: !models.length })
      }
    } catch { /* ignore */ }
  }

  if (models.length === 0) {
    models.push(
      { label: 'gemini-2.5-pro', value: 'gemini-2.5-pro' },
      { label: 'gemini-2.5-flash', value: 'gemini-2.5-flash' },
    )
  }

  return models
}

// --- Agent definitions ---

const AGENT_DEFS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    commands: ['claude'],
    configDirs: [path.join(os.homedir(), '.claude')],
    readModels: readClaudeModels,
  },
  {
    id: 'codex',
    name: 'Codex (OpenAI)',
    commands: ['codex'],
    configDirs: [
      path.join(os.homedir(), '.codex'),
      path.join(os.homedir(), '.config', 'codex'),
    ],
    readModels: readCodexModels,
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    commands: ['gemini'],
    configDirs: [
      path.join(os.homedir(), '.gemini'),
      path.join(os.homedir(), '.config', 'gemini'),
    ],
    readModels: readGeminiModels,
  },
]

function findExecutable(commands: string[]): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  for (const name of commands) {
    try {
      const result = execSync(`${cmd} ${name}`, { stdio: 'pipe', encoding: 'utf-8' })
      const firstLine = result.trim().split(/\r?\n/)[0]
      if (firstLine && fs.existsSync(firstLine)) return firstLine
    } catch {
      // not found
    }
  }
  return null
}

function findConfigDir(dirs: string[]): string | null {
  for (const dir of dirs) {
    if (fs.existsSync(dir)) return dir
  }
  return null
}

export function detectLocalAgents(): DetectedAgent[] {
  const detected: DetectedAgent[] = []

  for (const def of AGENT_DEFS) {
    const exePath = findExecutable(def.commands)
    const configDir = findConfigDir(def.configDirs)

    if (exePath || configDir) {
      const models = configDir ? def.readModels(configDir) : []
      detected.push({
        id: def.id,
        name: def.name,
        exe_path: exePath,
        config_dir: configDir,
        models,
      })
    }
  }

  return detected
}

export async function syncDetectedAgents(apiBase: string): Promise<void> {
  const agents = detectLocalAgents()
  console.log(`Detected ${agents.length} local agent(s):`)
  for (const agent of agents) {
    console.log(`  ${agent.name}: ${agent.exe_path || agent.config_dir}`)
  }

  // POST to API to store in DB
  try {
    await fetch(`${apiBase}/api/agents/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents }),
    })
  } catch (e) {
    console.error('  Failed to sync detection results:', e)
  }
}

// Run directly
const args = process.argv.slice(2)
if (args.includes('--sync')) {
  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : '8787'
  syncDetectedAgents(`http://localhost:${port}`).then(() => {
    console.log('  Synced to Agent-IM.')
  })
} else {
  const agents = detectLocalAgents()
  if (agents.length === 0) {
    console.log('No local agents detected.')
  } else {
    console.log(JSON.stringify(agents, null, 2))
  }
}
