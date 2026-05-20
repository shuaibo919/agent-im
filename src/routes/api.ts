import { Hono } from 'hono'
import type { Env } from '../types.js'
import {
  getStatus,
  upsertProfile,
  listProfiles,
  createThread,
  listThreads,
  sendMessage,
  readMessages,
  closeThread,
  deleteMessage,
  deleteThread,
  ServiceError,
} from '../services/im.js'

// Thread :id param is now a number (or "#N" string) — pass as string to service for parsing


const api = new Hono<{ Bindings: Env }>()

// Error handler helper
function handleError(e: unknown) {
  if (e instanceof ServiceError) {
    return Response.json({ error: e.message }, { status: e.status })
  }
  const message = e instanceof Error ? e.message : 'Internal server error'
  return Response.json({ error: message }, { status: 500 })
}

// GET /api/status
api.get('/status', async (c) => {
  try {
    const status = await getStatus(c.env.DB)
    return c.json(status)
  } catch (e) {
    return handleError(e)
  }
})

// POST /api/profiles
api.post('/profiles', async (c) => {
  try {
    const body = await c.req.json()
    const { profile, created } = await upsertProfile(c.env.DB, body)
    return c.json(profile, created ? 201 : 200)
  } catch (e) {
    return handleError(e)
  }
})

// GET /api/profiles
api.get('/profiles', async (c) => {
  try {
    const profiles = await listProfiles(c.env.DB)
    return c.json({ profiles })
  } catch (e) {
    return handleError(e)
  }
})

// POST /api/threads
api.post('/threads', async (c) => {
  try {
    const body = await c.req.json()
    const thread = await createThread(c.env.DB, body)
    return c.json(thread, 201)
  } catch (e) {
    return handleError(e)
  }
})

// GET /api/threads
api.get('/threads', async (c) => {
  try {
    const profileId = c.req.query('profile_id')
    if (!profileId) {
      return c.json({ error: 'profile_id query parameter is required' }, 400)
    }
    const query = {
      profile_id: profileId,
      include_closed: c.req.query('include_closed') === 'true',
      include_all: c.req.query('include_all') === 'true',
    }
    const threads = await listThreads(c.env.DB, query)
    return c.json({ threads })
  } catch (e) {
    return handleError(e)
  }
})

// POST /api/threads/:id/messages
api.post('/threads/:id/messages', async (c) => {
  try {
    const threadId = c.req.param('id')
    const body = await c.req.json()
    const message = await sendMessage(c.env.DB, threadId, body)
    return c.json(message, 201)
  } catch (e) {
    return handleError(e)
  }
})

// GET /api/threads/:id/messages
api.get('/threads/:id/messages', async (c) => {
  try {
    const threadId = c.req.param('id')
    const reader = c.req.query('reader')
    if (!reader) {
      return c.json({ error: 'reader query parameter is required' }, 400)
    }
    const query = {
      reader,
      since: c.req.query('since'),
      before: c.req.query('before'),
      limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
    }
    const result = await readMessages(c.env.DB, threadId, query)
    return c.json(result)
  } catch (e) {
    return handleError(e)
  }
})

// PUT /api/threads/:id
api.put('/threads/:id', async (c) => {
  try {
    const threadId = c.req.param('id')
    const body = await c.req.json()
    const thread = await closeThread(c.env.DB, threadId, body)
    return c.json(thread)
  } catch (e) {
    return handleError(e)
  }
})

// DELETE /api/threads/:id
api.delete('/threads/:id', async (c) => {
  try {
    const threadId = c.req.param('id')
    await deleteThread(c.env.DB, threadId)
    return c.json({ deleted: true })
  } catch (e) {
    return handleError(e)
  }
})

// NOTE: /api/threads/:id/invoke has been moved to the Node.js orchestrator proxy (port 9000)
// Workers (workerd) cannot fetch localhost, so invoke must run in Node.js

// DELETE /api/messages/:id
api.delete('/messages/:id', async (c) => {
  try {
    const msgId = c.req.param('id')
    await deleteMessage(c.env.DB, msgId)
    return c.json({ deleted: true })
  } catch (e) {
    return handleError(e)
  }
})

// GET /api/profiles/:id
api.get('/profiles/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const profile = await c.env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first()
    if (!profile) return c.json({ error: 'Profile not found' }, 404)
    return c.json(profile)
  } catch (e) {
    return handleError(e)
  }
})

// DELETE /api/profiles/:id
api.delete('/profiles/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const result = await c.env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(id).run()
    if (!result.meta.changes) return c.json({ error: 'Profile not found' }, 404)
    return c.json({ deleted: true })
  } catch (e) {
    return handleError(e)
  }
})

// POST /api/agents/launch — hint to orchestrator to launch an agent for a thread
// In Workers runtime this just stores the request; the Node.js orchestrator polls or is notified
api.post('/agents/launch', async (c) => {
  try {
    const body = await c.req.json<{ thread_id: number; agent_id: string; base_agent_id?: string; workspace: string }>()
    if (!body.thread_id || !body.agent_id || !body.workspace) {
      return c.json({ error: 'thread_id, agent_id, and workspace are required' }, 400)
    }
    // Store as a pending launch request in agent_endpoints with a special status
    const endpointId = `${body.agent_id}-thread-${body.thread_id}`
    await c.env.DB.prepare(
      `INSERT INTO agent_endpoints (id, mcp_url, display_name, status, capabilities)
       VALUES (?, ?, ?, 'pending_launch', ?)
       ON CONFLICT(id) DO UPDATE SET status='pending_launch', capabilities=excluded.capabilities, updated_at=datetime('now')`
    ).bind(
      endpointId,
      `http://localhost:0/mcp`, // placeholder, orchestrator will update
      `${body.agent_id} (Thread #${body.thread_id})`,
      JSON.stringify({
        thread_id: body.thread_id,
        agent_id: body.agent_id,
        base_agent_id: body.base_agent_id || body.agent_id,
        workspace: body.workspace,
      })
    ).run()
    return c.json({ queued: true, endpoint_id: endpointId })
  } catch (e) {
    return handleError(e)
  }
})

// POST /api/agents/local — store detected agents (called by start script)
api.post('/agents/local', async (c) => {
  try {
    const { agents } = await c.req.json<{ agents: { id: string; name: string; exe_path: string | null; config_dir: string | null; models: { label: string; value: string }[] }[] }>()
    // Clear and re-insert
    await c.env.DB.prepare('DELETE FROM local_agents').run()
    for (const agent of agents) {
      await c.env.DB.prepare(
        'INSERT INTO local_agents (id, name, exe_path, config_dir, models) VALUES (?, ?, ?, ?, ?)'
      ).bind(agent.id, agent.name, agent.exe_path, agent.config_dir, JSON.stringify(agent.models)).run()
    }
    return c.json({ synced: agents.length })
  } catch (e) {
    return handleError(e)
  }
})

// GET /api/agents/local — get detected agents
api.get('/agents/local', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM local_agents ORDER BY name').all()
    return c.json({ agents: results })
  } catch (e) {
    return handleError(e)
  }
})

export default api
