/**
 * Agent Context — read/write per-agent markdown context files in thread workspace.
 * Each agent gets its own AGENT-<id>.md file containing persona and compressed history.
 */

import fs from 'node:fs'
import path from 'node:path'

export function getContextFilePath(workspace: string, agentId: string): string {
  return path.join(workspace, `AGENT-${agentId}.md`)
}

export function readAgentContext(workspace: string, agentId: string): string | null {
  const filePath = getContextFilePath(workspace, agentId)
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function initAgentContextFile(workspace: string, agentId: string, persona: string | null, participants?: string[]): void {
  const filePath = getContextFilePath(workspace, agentId)
  const participantList = participants?.filter(p => p !== agentId).join(', ') || 'unknown'

  // Don't overwrite if already exists
  if (fs.existsSync(filePath)) {
    // Update persona section if provided and different
    if (persona) {
      const content = fs.readFileSync(filePath, 'utf-8')
      const personaSection = extractSection(content, 'Persona')
      if (personaSection !== persona) {
        const updated = replaceSection(content, 'Persona', persona)
        fs.writeFileSync(filePath, updated, 'utf-8')
      }
    }
    // Update Communication Rules with current participant list
    if (participants) {
      let content = fs.readFileSync(filePath, 'utf-8')
      const rulesContent = buildCommunicationRules(agentId, participantList)
      if (content.includes('## Communication Rules')) {
        content = replaceSection(content, 'Communication Rules', rulesContent)
      } else {
        // Insert before ## Thread Summary
        const marker = '## Thread Summary'
        const idx = content.indexOf(marker)
        if (idx !== -1) {
          content = content.slice(0, idx) + `## Communication Rules\n${rulesContent}\n\n` + content.slice(idx)
        }
      }
      fs.writeFileSync(filePath, content, 'utf-8')
    }
    return
  }

  const rulesContent = buildCommunicationRules(agentId, participantList)
  const content = `# Agent Context: ${agentId}

## Persona
${persona || 'No persona configured.'}

## Communication Rules
${rulesContent}

## Thread Summary
`
  fs.writeFileSync(filePath, content, 'utf-8')
}

function buildCommunicationRules(agentId: string, participantList: string): string {
  return `- You are "${agentId}" in a group thread. Other participants can see your reply.
- Other participants: ${participantList}
- To direct a message at a specific participant, use @their-name (e.g., @codex, @claude-code).
- When you @mention another agent, they will be triggered to respond to you.
- Only use @mentions when you genuinely need input from that specific agent.
- Do NOT @mention yourself.`
}

export function appendCompressedSummary(
  workspace: string,
  agentId: string,
  summary: string,
  messageRange: string,
): void {
  const filePath = getContextFilePath(workspace, agentId)
  const timestamp = new Date().toISOString()
  const section = `\n### Compressed at ${timestamp} (messages ${messageRange})\n${summary}\n`

  if (!fs.existsSync(filePath)) {
    initAgentContextFile(workspace, agentId, null)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  // Append after ## Thread Summary
  const marker = '## Thread Summary'
  const idx = content.indexOf(marker)
  if (idx !== -1) {
    const insertPos = idx + marker.length
    const updated = content.slice(0, insertPos) + section + content.slice(insertPos)
    fs.writeFileSync(filePath, updated, 'utf-8')
  } else {
    // No summary section — append at end
    fs.writeFileSync(filePath, content + `\n${marker}${section}`, 'utf-8')
  }
}

/** Get the highest message index that has been compressed (e.g. "messages 1-50" returns 50) */
export function getLastCompressedMessageIndex(workspace: string, agentId: string): number {
  const content = readAgentContext(workspace, agentId)
  if (!content) return 0

  const matches = [...content.matchAll(/\(messages \d+-(\d+)\)/g)]
  if (matches.length === 0) return 0
  return Math.max(...matches.map(m => parseInt(m[1], 10)))
}

// --- Helpers ---

function extractSection(content: string, sectionName: string): string {
  const re = new RegExp(`## ${sectionName}\\n([\\s\\S]*?)(?=\\n## |$)`)
  const match = content.match(re)
  return match ? match[1].trim() : ''
}

function replaceSection(content: string, sectionName: string, newContent: string): string {
  const re = new RegExp(`(## ${sectionName}\\n)[\\s\\S]*?(?=\\n## |$)`)
  return content.replace(re, `$1${newContent}\n`)
}
