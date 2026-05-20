import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AgentEndpointRow, RegisterEndpointInput } from '../types.js'

export class BridgeError extends Error {
  constructor(
    message: string,
    public status: number = 400,
  ) {
    super(message)
  }
}

export async function registerEndpoint(
  db: D1Database,
  input: RegisterEndpointInput,
): Promise<AgentEndpointRow> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO agent_endpoints (id, mcp_url, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET mcp_url=excluded.mcp_url, display_name=excluded.display_name, status='active', updated_at=excluded.updated_at`,
    )
    .bind(input.id, input.mcp_url, input.display_name ?? null, now, now)
    .run()

  const row = await db
    .prepare('SELECT * FROM agent_endpoints WHERE id = ?')
    .bind(input.id)
    .first<AgentEndpointRow>()
  return row!
}

export async function removeEndpoint(db: D1Database, id: string): Promise<void> {
  const result = await db.prepare('DELETE FROM agent_endpoints WHERE id = ?').bind(id).run()
  if (!result.meta.changes) {
    throw new BridgeError(`Endpoint "${id}" not found`, 404)
  }
}

export async function listEndpoints(db: D1Database): Promise<AgentEndpointRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM agent_endpoints ORDER BY created_at DESC')
    .all<AgentEndpointRow>()
  return results
}

async function createClient(mcpUrl: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
  const client = new Client({ name: 'Agent-IM-Bridge', version: '0.3.0' })
  await client.connect(transport)
  return client
}

export async function probeEndpoint(db: D1Database, id: string): Promise<AgentEndpointRow> {
  const row = await db
    .prepare('SELECT * FROM agent_endpoints WHERE id = ?')
    .bind(id)
    .first<AgentEndpointRow>()
  if (!row) throw new BridgeError(`Endpoint "${id}" not found`, 404)

  try {
    const client = await createClient(row.mcp_url)
    const { tools } = await client.listTools()
    const toolNames = tools.map((t) => t.name)

    const now = new Date().toISOString()
    await db
      .prepare(
        `UPDATE agent_endpoints SET status='active', tools=?, last_connected_at=?, last_error=NULL, updated_at=? WHERE id=?`,
      )
      .bind(JSON.stringify(toolNames), now, now, id)
      .run()

    await client.close()

    return (await db
      .prepare('SELECT * FROM agent_endpoints WHERE id = ?')
      .bind(id)
      .first<AgentEndpointRow>())!
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    const now = new Date().toISOString()
    await db
      .prepare(
        `UPDATE agent_endpoints SET status='error', last_error=?, updated_at=? WHERE id=?`,
      )
      .bind(errMsg, now, id)
      .run()
    throw new BridgeError(`Failed to connect to "${id}": ${errMsg}`, 502)
  }
}

export async function callRemoteTool(
  db: D1Database,
  endpointId: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const row = await db
    .prepare('SELECT * FROM agent_endpoints WHERE id = ?')
    .bind(endpointId)
    .first<AgentEndpointRow>()
  if (!row) throw new BridgeError(`Endpoint "${endpointId}" not found`, 404)
  if (row.status === 'inactive') {
    throw new BridgeError(`Endpoint "${endpointId}" is inactive`, 400)
  }
  if (row.status === 'pending_launch') {
    throw new BridgeError(`Endpoint "${endpointId}" is still launching. Please wait.`, 503)
  }

  try {
    const client = await createClient(row.mcp_url)
    const result = await client.callTool({ name: toolName, arguments: args })
    await client.close()

    const now = new Date().toISOString()
    await db
      .prepare('UPDATE agent_endpoints SET last_connected_at=?, updated_at=? WHERE id=?')
      .bind(now, now, endpointId)
      .run()

    return result
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    const now = new Date().toISOString()
    await db
      .prepare('UPDATE agent_endpoints SET last_error=?, updated_at=? WHERE id=?')
      .bind(errMsg, now, endpointId)
      .run()
    throw new BridgeError(`Tool call failed on "${endpointId}": ${errMsg}`, 502)
  }
}
