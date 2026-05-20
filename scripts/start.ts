import { execSync, spawn } from 'node:child_process'
import path from 'node:path'
import { configure } from './configure-mcp.js'
import { syncDetectedAgents } from './detect-agents.js'
import {
  launchAgent,
  stopAllAgents,
  startProxyServer,
} from './orchestrator.js'

const args = process.argv.slice(2)
const projectFlag = args.includes('--project')
const skipConfigure = args.includes('--skip-configure')
const portIdx = args.indexOf('--port')
const port = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : '8787'

const root = path.resolve(import.meta.dirname, '..')
const apiBase = `http://localhost:${port}`
const proxyPort = 9000

// Step 1: DB init
console.log('[1/3] Initializing database...')
try {
  execSync('npx wrangler d1 execute agent-im-db --local --file=src/db/schema.sql', {
    cwd: root,
    stdio: 'inherit',
  })
  // Run migrations (ALTER TABLE etc. — errors are expected if already applied)
  try {
    execSync('npx wrangler d1 execute agent-im-db --local --file=src/db/migrations.sql', {
      cwd: root,
      stdio: 'ignore',
    })
  } catch { /* migration already applied */ }
  console.log('  Database ready.')
} catch {
  console.error('  Warning: DB init failed, it may already exist.')
}

// Step 2: Configure MCP
if (!skipConfigure) {
  console.log('[2/3] Configuring Claude Code MCP...')
  const configArgs = [`--url`, `http://localhost:${port}/mcp`]
  if (projectFlag) configArgs.push('--project')
  configure(configArgs)
} else {
  console.log('[2/3] Skipping MCP configuration (--skip-configure)')
}

// Step 3: Start dev server
console.log(`[3/3] Starting dev server on port ${port}...`)
const child = spawn('npx', ['wrangler', 'dev', '--port', port], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
})

// Forward signals for clean shutdown
process.on('SIGINT', async () => {
  console.log('\n[shutdown] Stopping all agent processes...')
  await stopAllAgents(apiBase)
  child.kill('SIGINT')
})
process.on('SIGTERM', async () => {
  await stopAllAgents(apiBase)
  child.kill('SIGTERM')
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})

// Health check, then start everything
setTimeout(async () => {
  try {
    const res = await fetch(`${apiBase}/api/status`)
    if (res.ok) {
      console.log('\n Agent-IM is ready!')
      console.log(`  Web UI:  ${apiBase}/chat`)
      console.log(`  MCP:     ${apiBase}/mcp`)
      console.log(`  API:     ${apiBase}/api`)
      console.log(`  Proxy:   http://localhost:${proxyPort}`)

      // Start orchestrator proxy server
      startProxyServer(proxyPort, apiBase)

      // Detect and sync local agents
      console.log('\n[detect] Scanning for local agents...')
      await syncDetectedAgents(apiBase)

      // Recover agents for open threads
      console.log('[orchestrator] Recovering agents for open threads...')
      await recoverAgentsForOpenThreads(apiBase)

      // Start polling for pending agent launches
      console.log('[orchestrator] Watching for agent launch requests...')
      pollPendingLaunches()
    }
  } catch {
    // Server still starting
  }
}, 3000)

function pollPendingLaunches() {
  setInterval(async () => {
    try {
      const res = await fetch(`${apiBase}/api/bridge/endpoints`)
      if (!res.ok) return
      const data = await res.json() as { endpoints: { id: string; status: string; capabilities: string | null }[] }
      const pending = (data.endpoints || []).filter(ep => ep.status === 'pending_launch')

      for (const ep of pending) {
        if (!ep.capabilities) continue
        try {
          const caps = JSON.parse(ep.capabilities) as {
            thread_id: number; agent_id: string; base_agent_id?: string; workspace: string
          }
          const baseAgent = caps.base_agent_id || caps.agent_id
          console.log(`[orchestrator] Launching ${baseAgent} (as ${caps.agent_id}) for thread #${caps.thread_id}`)
          const { port: p } = await launchAgent(apiBase, caps.thread_id, caps.agent_id, caps.workspace, baseAgent)
          console.log(`[orchestrator] ${caps.agent_id} ready on port ${p}`)
        } catch (e) {
          console.error(`[orchestrator] Failed to launch ${ep.id}:`, e)
          try {
            await fetch(`${apiBase}/api/bridge/endpoints`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: ep.id, mcp_url: 'http://localhost:0/error', display_name: ep.id }),
            })
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }, 2000)
}

const KNOWN_AGENT_IDS = ['claude-code', 'codex', 'gemini-cli']

async function recoverAgentsForOpenThreads(base: string): Promise<void> {
  try {
    const res = await fetch(`${base}/api/threads?profile_id=user&include_all=true`)
    if (!res.ok) return
    const data = await res.json() as { threads: { id: number; participants: string; workspace: string | null; status: string }[] }
    const openThreads = (data.threads || []).filter(t => t.status === 'open' && t.workspace)
    let count = 0
    for (const thread of openThreads) {
      const participants: (string | { id: string })[] = JSON.parse(thread.participants)
      const pIds = participants.map(p => typeof p === 'string' ? p : p.id)
      for (const pid of pIds) {
        const baseAgent = KNOWN_AGENT_IDS.find(k => pid === k || pid.startsWith(k + '-'))
        if (baseAgent) {
          try {
            await fetch(`${base}/api/agents/launch`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ thread_id: thread.id, agent_id: pid, base_agent_id: baseAgent, workspace: thread.workspace }),
            })
            count++
          } catch { /* ignore */ }
        }
      }
    }
    if (count > 0) console.log(`[orchestrator] Queued ${count} agent(s) for recovery`)
  } catch { /* ignore */ }
}
