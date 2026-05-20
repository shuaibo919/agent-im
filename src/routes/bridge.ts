import { Hono } from 'hono'
import type { Env } from '../types.js'
import {
  registerEndpoint,
  removeEndpoint,
  listEndpoints,
  probeEndpoint,
  callRemoteTool,
  BridgeError,
} from '../services/bridge.js'

const bridge = new Hono<{ Bindings: Env }>()

// Register an agent endpoint
bridge.post('/endpoints', async (c) => {
  const body = await c.req.json<{ id: string; mcp_url: string; display_name?: string }>()
  if (!body.id || !body.mcp_url) {
    return c.json({ error: 'id and mcp_url are required' }, 400)
  }
  try {
    const endpoint = await registerEndpoint(c.env.DB, body)
    return c.json(endpoint, 201)
  } catch (e) {
    if (e instanceof BridgeError) return c.json({ error: e.message }, e.status as 400)
    const msg = e instanceof Error ? e.message : 'Internal server error'
    return c.json({ error: msg }, 500)
  }
})

// List all endpoints
bridge.get('/endpoints', async (c) => {
  const endpoints = await listEndpoints(c.env.DB)
  return c.json({ endpoints })
})

// Remove an endpoint
bridge.delete('/endpoints/:id', async (c) => {
  const id = c.req.param('id')
  try {
    await removeEndpoint(c.env.DB, id)
    return c.json({ ok: true })
  } catch (e) {
    if (e instanceof BridgeError) return c.json({ error: e.message }, e.status as 404)
    const msg = e instanceof Error ? e.message : 'Internal server error'
    return c.json({ error: msg }, 500)
  }
})

// Probe an endpoint (discover tools)
bridge.post('/endpoints/:id/probe', async (c) => {
  const id = c.req.param('id')
  try {
    const endpoint = await probeEndpoint(c.env.DB, id)
    return c.json(endpoint)
  } catch (e) {
    if (e instanceof BridgeError) return c.json({ error: e.message }, e.status as 502)
    const msg = e instanceof Error ? e.message : 'Internal server error'
    return c.json({ error: msg }, 500)
  }
})

// Call a tool on a remote agent
bridge.post('/endpoints/:id/call', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ tool: string; arguments?: Record<string, unknown> }>()
  if (!body.tool) {
    return c.json({ error: 'tool is required' }, 400)
  }
  try {
    const result = await callRemoteTool(c.env.DB, id, body.tool, body.arguments)
    return c.json({ result })
  } catch (e) {
    if (e instanceof BridgeError) return c.json({ error: e.message }, e.status as 502)
    const msg = e instanceof Error ? e.message : 'Internal server error'
    return c.json({ error: msg }, 500)
  }
})

export default bridge
