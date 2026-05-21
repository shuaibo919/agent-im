/**
 * Orchestrator — manages agent subprocess lifecycle + HTTP proxy server.
 * Runs in Node.js (start script / Electron), NOT in Workers runtime.
 *
 * - Launches agent-server.ts subprocess per agent participant in a thread
 * - Runs an HTTP proxy server (port 9000) that handles invoke calls
 *   (Workers can't fetch localhost, so the UI calls this proxy directly)
 * - Provides agent status endpoint
 */

import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import {
  initAgentContextFile,
  getLastCompressedMessageIndex,
  appendCompressedSummary,
} from './agent-context.js'

// In CJS (bundled by esbuild) __dirname is native; in ESM (tsx) it's shimmed
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — __dirname exists at runtime in both contexts
const SCRIPTS_DIR: string = __dirname
const AGENT_SERVER_SCRIPT = process.env.AGENT_SERVER_PATH || path.join(SCRIPTS_DIR, 'agent-server.ts')
const AGENT_SERVER_CMD = AGENT_SERVER_SCRIPT.endsWith('.cjs') || AGENT_SERVER_SCRIPT.endsWith('.js') ? 'node' : 'tsx'
const BASE_PORT = 9001
let nextPort = BASE_PORT

interface AgentProcess {
  threadId: number
  agentId: string
  port: number
  process: ChildProcess
  workspace: string
}

// Active agent processes keyed by "threadId:agentId"
const activeAgents = new Map<string, AgentProcess>()

function agentKey(threadId: number, agentId: string): string {
  return `${threadId}:${agentId}`
}

/** Launch an agent-server subprocess for a given agent in a thread workspace */
export async function launchAgent(
  apiBase: string,
  threadId: number,
  agentId: string,
  workspace: string,
  baseAgentType?: string,
  model?: string,
  participants?: string[],
): Promise<{ port: number; url: string }> {
  const key = agentKey(threadId, agentId)

  // Already running
  if (activeAgents.has(key)) {
    const existing = activeAgents.get(key)!
    return { port: existing.port, url: `http://localhost:${existing.port}` }
  }

  const port = nextPort++
  const url = `http://localhost:${port}`

  // Each agent gets its own subdirectory so it cannot read other agents' persona/context files
  const agentWorkspace = path.join(workspace, `.agent-${agentId}`)
  try { fs.mkdirSync(agentWorkspace, { recursive: true }) } catch { /* ignore */ }

  // Fetch agent's persona from profile and initialize context MD file
  let persona: string | null = null
  try {
    const profRes = await fetch(`${apiBase}/api/profiles/${encodeURIComponent(agentId)}`)
    if (profRes.ok) {
      const profile = await profRes.json() as { persona?: string | null }
      persona = profile.persona || null
    }
  } catch { /* ignore */ }
  initAgentContextFile(agentWorkspace, agentId, persona, participants)

  // Use base agent type for the CLI command (e.g. "claude-code" for "claude-code-opus4")
  const agentType = baseAgentType || agentId

  const cmdArgs = [
    AGENT_SERVER_SCRIPT,
    '--agent', agentType,
    '--workspace', agentWorkspace,
    '--port', String(port),
  ]
  if (model) cmdArgs.push('--model', model)

  console.log(`[orchestrator] Spawning: ${AGENT_SERVER_CMD} ${cmdArgs.join(' ')}`)

  const child = spawn(AGENT_SERVER_CMD, cmdArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env },
  })

  child.stdout?.on('data', (data: Buffer) => {
    console.log(`[agent:${agentId}:#${threadId}] ${data.toString().trim()}`)
  })
  child.stderr?.on('data', (data: Buffer) => {
    console.error(`[agent:${agentId}:#${threadId}] ${data.toString().trim()}`)
  })

  child.on('exit', (code) => {
    console.log(`[orchestrator] ${agentId} for thread #${threadId} exited (code ${code})`)
    activeAgents.delete(key)
  })

  activeAgents.set(key, { threadId, agentId, port, process: child, workspace: agentWorkspace })

  // Wait for server to be ready
  await waitForReady(port, 15_000)

  // Register as endpoint in DB
  const endpointId = `${agentId}-thread-${threadId}`
  try {
    await fetch(`${apiBase}/api/bridge/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: endpointId,
        mcp_url: `${url}/mcp`,
        display_name: `${agentId} (Thread #${threadId})`,
      }),
    })
    console.log(`[orchestrator] Registered endpoint ${endpointId} → ${url}`)
  } catch (e) {
    console.error(`[orchestrator] Failed to register endpoint:`, e)
  }

  return { port, url }
}

/** Stop an agent process for a thread */
export async function stopAgent(
  apiBase: string,
  threadId: number,
  agentId: string,
): Promise<void> {
  const key = agentKey(threadId, agentId)
  const agent = activeAgents.get(key)
  if (!agent) return

  agent.process.kill('SIGTERM')
  activeAgents.delete(key)

  try {
    await fetch(`${apiBase}/api/bridge/endpoints/${agentId}-thread-${threadId}`, {
      method: 'DELETE',
    })
  } catch { /* ignore */ }
}

/** Stop all agents for a given thread */
export async function stopThreadAgents(apiBase: string, threadId: number): Promise<void> {
  const toStop: string[] = []
  for (const [, agent] of activeAgents) {
    if (agent.threadId === threadId) toStop.push(agent.agentId)
  }
  await Promise.all(toStop.map((id) => stopAgent(apiBase, threadId, id)))
}

/** Stop all running agent processes */
export async function stopAllAgents(apiBase: string): Promise<void> {
  const entries = [...activeAgents.values()]
  await Promise.all(entries.map((a) => stopAgent(apiBase, a.threadId, a.agentId)))
}

/** Get agent status for a thread (or all) */
export function getAgentStatuses(threadId?: number): { threadId: number; agentId: string; port: number; status: string }[] {
  const results: { threadId: number; agentId: string; port: number; status: string }[] = []
  for (const [, agent] of activeAgents) {
    if (threadId !== undefined && agent.threadId !== threadId) continue
    results.push({
      threadId: agent.threadId,
      agentId: agent.agentId,
      port: agent.port,
      status: 'running',
    })
  }
  return results
}

// =============================================
// @mention parsing
// =============================================

/** Parse @mentions from message content, matching against thread participant IDs */
function parseMentionsFromContent(content: string, participantIds: string[]): string[] {
  const mentions: string[] = []
  const re = /@([\w-]+)/g
  let m
  while ((m = re.exec(content)) !== null) {
    const mention = m[1]
    // Fuzzy match: @codex matches codex-gpt-5-5, @claude-code matches claude-code-opus4
    const found = participantIds.find(id =>
      id === mention || id.startsWith(mention + '-') || mention.startsWith(id + '-')
    )
    if (found && !mentions.includes(found)) mentions.push(found)
  }
  return mentions
}

// =============================================
// HTTP Proxy Server — handles invoke & status
// =============================================

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(data))
}

/**
 * Start the orchestrator proxy HTTP server.
 * Handles:
 *   POST /invoke  — call agent + write reply to thread
 *   GET  /agents/status — agent process statuses
 */
export function startProxyServer(proxyPort: number, apiBase: string): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') { json(res, 204, ''); return }

    // --- POST /invoke ---
    if (req.method === 'POST' && req.url === '/invoke') {
      try {
        const body = JSON.parse(await readBody(req)) as {
          thread_id: number
          agent_id: string
          message: string
          context?: string
          chain_depth?: number
          participants?: string[]
        }

        if (!body.thread_id || !body.agent_id || !body.message) {
          json(res, 400, { error: 'thread_id, agent_id, and message are required' })
          return
        }

        const chainDepth = body.chain_depth || 0

        // Find the running agent process
        const key = agentKey(body.thread_id, body.agent_id)
        const agent = activeAgents.get(key)
        if (!agent) {
          json(res, 404, { error: `Agent ${body.agent_id} is not running for thread #${body.thread_id}` })
          return
        }

        // Fetch thread history for context
        let context = body.context || ''
        try {
          const historyRes = await fetch(
            `${apiBase}/api/threads/${body.thread_id}/messages?reader=${encodeURIComponent(body.agent_id)}&limit=50`
          )
          if (historyRes.ok) {
            const historyData = await historyRes.json() as {
              messages: { sender: string; content: string; created_at: string }[]
              remaining_count: number
            }
            const msgs = historyData.messages || []
            const totalCount = msgs.length + (historyData.remaining_count || 0)

            // Trigger compression if >50 messages and there are uncompressed old messages
            if (totalCount > 50 && agent.workspace) {
              try {
                const lastCompressed = getLastCompressedMessageIndex(agent.workspace, body.agent_id)
                const uncompressedCount = totalCount - lastCompressed
                if (uncompressedCount > 50) {
                  // Fetch older messages for compression (skip recent 20)
                  const olderMsgs = msgs.slice(0, Math.max(msgs.length - 20, 0))
                  if (olderMsgs.length > 0) {
                    const historyText = olderMsgs
                      .map((m: { sender: string; content: string }) => `[${m.sender}]: ${m.content}`)
                      .join('\n')
                    const compressPrompt = `Summarize the following conversation history into a concise summary (under 500 words). Focus on: decisions made, key context, action items, and unresolved questions.\n\nMessages:\n${historyText}`
                    console.log(`[proxy] Compressing ${olderMsgs.length} messages for ${body.agent_id} in thread #${body.thread_id}`)
                    const compRes = await fetch(`http://localhost:${agent.port}/chat`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ message: compressPrompt }),
                    })
                    if (compRes.ok) {
                      const compData = await compRes.json() as { response: string }
                      const range = `${lastCompressed + 1}-${lastCompressed + olderMsgs.length}`
                      appendCompressedSummary(agent.workspace, body.agent_id, compData.response, range)
                      console.log(`[proxy] Compressed messages ${range} for ${body.agent_id}`)
                    }
                  }
                }
              } catch (e) { console.error('[proxy] Compression error:', e) }
            }

            if (msgs.length > 0) {
              // Build conversation context — only recent messages (last 20)
              const recentMsgs = msgs.slice(-20, -1)
              const history = recentMsgs
                .map((m: { sender: string; content: string }) => `[${m.sender}]: ${m.content}`)
                .join('\n')
              if (history) {
                context = `You are "${body.agent_id}" in a group thread. Other participants can see your reply.\n\nRecent conversation:\n${history}\n\nLatest message:`
              }
            }
          }
        } catch { /* proceed without history */ }

        // Call agent-server's /chat endpoint (Node.js → Node.js, localhost works fine)
        console.log(`[proxy] Invoking ${body.agent_id} for thread #${body.thread_id}`)
        const agentRes = await fetch(`http://localhost:${agent.port}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: body.message, context }),
        })

        if (!agentRes.ok) {
          const err = await agentRes.json().catch(() => ({ error: 'Agent call failed' })) as { error: string }
          json(res, 502, { error: `Agent error: ${err.error}` })
          return
        }

        const agentData = await agentRes.json() as { response: string }
        const responseText = agentData.response

        // Write agent's reply back to the thread via Workers API
        const msgRes = await fetch(`${apiBase}/api/threads/${body.thread_id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: body.agent_id, content: responseText }),
        })

        if (!msgRes.ok) {
          const err = await msgRes.json().catch(() => ({ error: 'Failed to post reply' })) as { error: string }
          json(res, 500, { error: err.error })
          return
        }

        const reply = await msgRes.json()
        console.log(`[proxy] ${body.agent_id} replied to thread #${body.thread_id}`)

        // --- Chain @mention: detect @mentions in agent reply and trigger follow-up ---
        const threadParticipantIds = body.participants || []
        if (threadParticipantIds.length > 0 && chainDepth < 4) {
          const mentionedAgents = parseMentionsFromContent(responseText, threadParticipantIds)
            .filter(id => id !== body.agent_id) // can't @mention yourself
          if (mentionedAgents.length > 0) {
            const nextDepth = chainDepth + 1
            console.log(`[proxy] Chain @mention (depth ${nextDepth}): ${body.agent_id} mentioned ${mentionedAgents.join(', ')}`)
            for (const mentionedId of mentionedAgents) {
              const mentionedKey = agentKey(body.thread_id, mentionedId)
              if (!activeAgents.has(mentionedKey)) continue // agent not running
              // Fire async — don't await, don't block the response
              fetch(`http://localhost:${proxyPort}/invoke`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  thread_id: body.thread_id,
                  agent_id: mentionedId,
                  message: responseText,
                  chain_depth: nextDepth,
                  participants: threadParticipantIds,
                }),
              }).catch(e => console.error(`[proxy] Chain invoke ${mentionedId} failed:`, e))
            }
          }
        } else if (chainDepth >= 4) {
          console.log(`[proxy] Chain depth limit reached (${chainDepth}), not processing @mentions in ${body.agent_id}'s reply`)
        }

        json(res, 200, reply)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[proxy] Invoke error:`, msg)
        json(res, 500, { error: msg })
      }
      return
    }

    // --- GET /agents/:threadId/:agentId/status — proxy to agent-server ---
    const agentStatusMatch = req.url?.match(/^\/agents\/(\d+)\/([\w-]+)\/status$/)
    if (req.method === 'GET' && agentStatusMatch) {
      const tid = parseInt(agentStatusMatch[1], 10)
      const aid = agentStatusMatch[2]
      const key = agentKey(tid, aid)
      const agent = activeAgents.get(key)
      if (!agent) { json(res, 404, { state: 'not_running', agent: aid }); return }
      try {
        const r = await fetch(`http://localhost:${agent.port}/status`)
        const data = await r.json()
        json(res, 200, data)
      } catch {
        json(res, 200, { agent: aid, state: 'processing', statusText: '' })
      }
      return
    }

    // --- GET /agents/status ---
    if (req.method === 'GET' && req.url?.startsWith('/agents/status')) {
      const url = new URL(req.url, `http://localhost:${proxyPort}`)
      const threadIdStr = url.searchParams.get('thread_id')
      const threadId = threadIdStr ? parseInt(threadIdStr, 10) : undefined
      const statuses = getAgentStatuses(threadId)
      json(res, 200, { agents: statuses })
      return
    }

    // --- GET /health ---
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { status: 'ok', active_agents: activeAgents.size })
      return
    }

    // --- GET /app-root ---
    if (req.method === 'GET' && req.url === '/app-root') {
      const root = process.env.APP_ROOT || path.resolve(SCRIPTS_DIR, '..')
      json(res, 200, { root })
      return
    }

    json(res, 404, { error: 'Not found' })
  })

  server.listen(proxyPort, () => {
    console.log(`[proxy] Orchestrator proxy listening on http://localhost:${proxyPort}`)
  })

  return server
}

// --- Helpers ---

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`)
      if (res.ok) return
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Agent server on port ${port} did not become ready within ${timeoutMs}ms`)
}
