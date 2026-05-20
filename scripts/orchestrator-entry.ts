/**
 * Orchestrator entry point — run by Electron or standalone.
 * Starts the proxy server + polls for pending agent launches.
 *
 * Usage: tsx scripts/orchestrator-entry.ts [--port 8787] [--proxy-port 9000]
 */

import {
  startProxyServer,
  launchAgent,
  stopAllAgents,
} from './orchestrator.js'
import { syncDetectedAgents } from './detect-agents.js'

const KNOWN_AGENT_IDS = ['claude-code', 'codex', 'gemini-cli']

const args = process.argv.slice(2)
function getArg(name: string, def: string): string {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def
}

const apiPort = getArg('port', '8787')
const proxyPort = parseInt(getArg('proxy-port', '9000'), 10)
const apiBase = `http://localhost:${apiPort}`

// Start proxy server
startProxyServer(proxyPort, apiBase)

// Detect and sync local agents
syncDetectedAgents(apiBase).then(() => {
  console.log('[orchestrator-entry] Local agents synced')
}).catch(() => {})

// Recover agents for open threads on startup
recoverAgentsForOpenThreads(apiBase).then((count) => {
  if (count > 0) console.log(`[orchestrator-entry] Queued ${count} agent(s) for recovery`)
}).catch(() => {})

/** Scan open threads and queue agent launches for any with workspace + agent participants */
async function recoverAgentsForOpenThreads(apiBase: string): Promise<number> {
  let count = 0
  try {
    const res = await fetch(`${apiBase}/api/threads?profile_id=user&include_all=true`)
    if (!res.ok) return 0
    const data = await res.json() as { threads: { id: number; participants: string; workspace: string | null; status: string }[] }
    const openThreads = (data.threads || []).filter(t => t.status === 'open' && t.workspace)

    for (const thread of openThreads) {
      const participants: (string | { id: string })[] = JSON.parse(thread.participants)
      const pIds = participants.map(p => typeof p === 'string' ? p : p.id)
      for (const pid of pIds) {
        const base = KNOWN_AGENT_IDS.find(k => pid === k || pid.startsWith(k + '-'))
        if (base) {
          try {
            await fetch(`${apiBase}/api/agents/launch`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                thread_id: thread.id,
                agent_id: pid,
                base_agent_id: base,
                workspace: thread.workspace,
              }),
            })
            count++
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
  return count
}

// Poll for pending agent launch requests
setInterval(async () => {
  try {
    const res = await fetch(`${apiBase}/api/bridge/endpoints`)
    if (!res.ok) return
    const data = await res.json() as { endpoints: { id: string; status: string; capabilities: string | null }[] }
    const pending = (data.endpoints || []).filter(
      (ep: { status: string }) => ep.status === 'pending_launch'
    )

    for (const ep of pending) {
      if (!ep.capabilities) continue
      try {
        const caps = JSON.parse(ep.capabilities) as {
          thread_id: number
          agent_id: string
          base_agent_id?: string
          workspace: string
        }
        const baseAgent = caps.base_agent_id || caps.agent_id
        console.log(
          `[orchestrator] Launching ${baseAgent} (as ${caps.agent_id}) for thread #${caps.thread_id}`
        )
        const { port } = await launchAgent(
          apiBase,
          caps.thread_id,
          caps.agent_id,
          caps.workspace,
          baseAgent,
        )
        console.log(`[orchestrator] Agent ready on port ${port}`)
      } catch (e) {
        console.error(`[orchestrator] Launch failed for ${ep.id}:`, e)
        // Mark as error
        try {
          await fetch(`${apiBase}/api/bridge/endpoints`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ep.id, mcp_url: 'http://localhost:0/error', display_name: ep.id }),
          })
        } catch { /* ignore */ }
      }
    }
  } catch { /* polling error */ }
}, 2000)

// Clean shutdown
process.on('SIGINT', async () => {
  await stopAllAgents(apiBase)
  process.exit(0)
})
process.on('SIGTERM', async () => {
  await stopAllAgents(apiBase)
  process.exit(0)
})
