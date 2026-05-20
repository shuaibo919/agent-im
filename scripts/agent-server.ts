#!/usr/bin/env tsx
/**
 * Agent HTTP Server — wraps a local CLI agent (claude, codex, gemini) as a simple HTTP service.
 * Each instance serves one agent type in one workspace directory.
 *
 * Usage:
 *   tsx scripts/agent-server.ts --agent claude-code --workspace /path/to/project --port 9001
 *
 * Endpoints:
 *   GET  /health              → { agent, workspace, status }
 *   POST /chat { message }    → { response }
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 ? args[idx + 1] : undefined
}

const agentId = getArg('agent') ?? 'claude-code'
const workspace = getArg('workspace') ?? process.cwd()
const port = parseInt(getArg('port') ?? '9001', 10)
const model = getArg('model')

/** Live processing status — exposed via GET /status */
let currentStatus: { state: 'idle' | 'processing'; statusText: string; startedAt: number | null } = {
  state: 'idle', statusText: '', startedAt: null,
}

/** Write message to a temp file to avoid shell escaping issues with newlines */
function writeTempPrompt(content: string): string {
  const tmpFile = path.join(os.tmpdir(), `aim-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  fs.writeFileSync(tmpFile, content, 'utf-8')
  return tmpFile
}

/** Agent CLI command builders — return { cmd, args, useFile? } */
interface AgentCommand {
  cmd: string
  args: string[]
  stdinFile?: string // if set, pipe this file's content to stdin
}

function getCommand(agentType: string, promptFile: string): AgentCommand {
  const isWin = process.platform === 'win32'
  const nullDev = isWin ? 'NUL' : '/dev/null'

  switch (agentType) {
    case 'claude-code': {
      // claude -p reads from stdin when prompt is "-", or we can pipe file content
      // Use shell: read file content and pipe to claude
      const modelFlag = model ? ` --model ${model}` : ''
      if (isWin) {
        return { cmd: `type "${promptFile}" | claude -p --output-format text${modelFlag}`, args: [] }
      }
      return { cmd: `cat "${promptFile}" | claude -p --output-format text${modelFlag}`, args: [] }
    }
    case 'codex': {
      // codex exec reads prompt from file via stdin redirect
      const modelFlag = model ? ` --model ${model}` : ''
      if (isWin) {
        return { cmd: `type "${promptFile}" | codex exec --sandbox workspace-write --skip-git-repo-check -${modelFlag}`, args: [] }
      }
      return { cmd: `cat "${promptFile}" | codex exec --sandbox workspace-write --skip-git-repo-check -${modelFlag}`, args: [] }
    }
    case 'gemini-cli': {
      if (isWin) {
        return { cmd: `type "${promptFile}" | gemini`, args: [] }
      }
      return { cmd: `cat "${promptFile}" | gemini`, args: [] }
    }
    default:
      throw new Error(`Unknown agent type: ${agentType}`)
  }
}

/** Read the agent's persistent context MD file from workspace */
function readPersistentContext(): string | null {
  // agentId here is the base type (e.g. "claude-code"), but the MD file uses the full profile ID
  // Look for any AGENT-*.md file that starts with our agentId
  try {
    const files = fs.readdirSync(workspace)
    const mdFile = files.find(f => f.startsWith('AGENT-') && f.endsWith('.md'))
    if (mdFile) {
      return fs.readFileSync(path.join(workspace, mdFile), 'utf-8')
    }
  } catch { /* ignore */ }
  return null
}

/** Execute agent CLI and return output */
function callAgent(message: string, context?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Read persistent context from workspace MD file
    const persistentCtx = readPersistentContext()
    let fullContext = context || ''
    if (persistentCtx) {
      fullContext = `--- Persistent Context ---\n${persistentCtx}\n--- End Persistent Context ---\n\n${fullContext}`
    }
    const fullMessage = fullContext ? `${fullContext}\n\n${message}` : message

    // Write to temp file to avoid shell argument issues with newlines/special chars
    const promptFile = writeTempPrompt(fullMessage)
    const { cmd, args: cmdArgs } = getCommand(agentId, promptFile)

    console.log(`[agent-server] Calling: ${cmd.substring(0, 120)}...`)

    currentStatus = { state: 'processing', statusText: '', startedAt: Date.now() }

    const child = spawn(cmd, cmdArgs, {
      cwd: workspace,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    // Close stdin (piping is handled by shell command)
    child.stdin?.end()

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
      // Extract last non-empty line as status text for live status
      const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length > 0) {
        currentStatus.statusText = lines[lines.length - 1].substring(0, 120)
      }
    })

    const cleanup = () => {
      try { fs.unlinkSync(promptFile) } catch { /* ignore */ }
      currentStatus = { state: 'idle', statusText: '', startedAt: null }
    }

    child.on('close', (code) => {
      cleanup()
      if (code !== 0 && !stdout) {
        reject(new Error(`Agent exited with code ${code}: ${stderr.substring(0, 500)}`))
      } else {
        const raw = stdout.trim() || stderr.trim()
        resolve(inlineLocalImages(raw))
      }
    })

    child.on('error', (err) => {
      cleanup()
      reject(new Error(`Failed to spawn agent: ${err.message}`))
    })

    // Timeout after 5 minutes
    setTimeout(() => {
      child.kill()
      cleanup()
      reject(new Error('Agent response timed out (5 min)'))
    }, 300_000)
  })
}

/** MIME type map for image extensions */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
}

/** Post-process agent response: convert local image file references to base64 data URIs */
function inlineLocalImages(text: string): string {
  // Match markdown links/images with local file paths:
  // [name](<path>) or ![name](path) or [name](C:\...) or [name](/abs/path)
  return text.replace(/(!?\[([^\]]*)\]\()<?([^>\s)]+)>?\)/g, (match, prefix, alt, filePath) => {
    // Only process local file paths (not URLs)
    if (filePath.startsWith('http://') || filePath.startsWith('https://') || filePath.startsWith('data:')) {
      return match
    }
    // Resolve relative paths against workspace
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(workspace, filePath)
    const ext = path.extname(absPath).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (!mime) return match // not an image file

    try {
      if (!fs.existsSync(absPath)) return match
      const stat = fs.statSync(absPath)
      if (stat.size > 512 * 1024) {
        // Too large for inline — keep as-is with a note
        return match
      }
      const buf = fs.readFileSync(absPath)
      const b64 = buf.toString('base64')
      const dataUri = `data:${mime};base64,${b64}`
      return `![${alt}](${dataUri})`
    } catch {
      return match
    }
  })
}

// --- Simple HTTP Server ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(data))
}

const httpServer = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    jsonResponse(res, 204, '')
    return
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    jsonResponse(res, 200, { agent: agentId, workspace, status: 'ok' })
    return
  }

  // Live processing status
  if (req.method === 'GET' && req.url === '/status') {
    jsonResponse(res, 200, { agent: agentId, ...currentStatus })
    return
  }

  // Chat endpoint
  if (req.method === 'POST' && req.url === '/chat') {
    try {
      const body = JSON.parse(await readBody(req))
      const { message, context } = body as { message: string; context?: string }

      if (!message) {
        jsonResponse(res, 400, { error: 'message is required' })
        return
      }

      console.log(`[agent-server] Received chat request: "${message.substring(0, 80)}..."`)
      const response = await callAgent(message, context)
      console.log(`[agent-server] Response: "${response.substring(0, 80)}..."`)

      jsonResponse(res, 200, { response })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error(`[agent-server] Error:`, errMsg)
      jsonResponse(res, 500, { error: errMsg })
    }
    return
  }

  jsonResponse(res, 404, { error: 'Not found' })
})

httpServer.listen(port, () => {
  console.log(`[agent-server] ${agentId} listening on http://localhost:${port}`)
  console.log(`[agent-server] workspace: ${workspace}`)
  if (model) console.log(`[agent-server] model: ${model}`)
})

// Clean shutdown
process.on('SIGINT', () => { httpServer.close(); process.exit(0) })
process.on('SIGTERM', () => { httpServer.close(); process.exit(0) })
