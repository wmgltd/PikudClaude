/**
 * Parsing of Claude Code's session transcripts (~/.claude/projects/**\/*.jsonl).
 * Pure — no fs, no Electron — so the format assumptions can be tested directly.
 */

export type ConvRole = 'user' | 'assistant' | 'tool_use' | 'tool_result'

export interface ConvMessage {
  id: string
  role: ConvRole
  text: string
  ts: number
  toolName?: string
}

/**
 * The folder name Claude Code flattens a working directory into.
 *
 * Every character that is not a letter or a digit becomes '-'. Confirmed
 * against the real store: across all of ~/.claude/projects the only
 * non-alphanumeric character appearing in any folder name is '-'. Substituting
 * only '/' (what this used to do) silently broke any path containing a space or
 * punctuation — the panel then watched a directory that does not exist and
 * reported "no messages yet" while the terminal was full of conversation.
 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/\/+$/, '').replace(/[^a-zA-Z0-9]/g, '-')
}

function extractTextOnly(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
  }
  return parts.join('\n').trim()
}

/** Turn one JSONL line into zero or more panel messages. Never throws. */
export function parseLine(raw: string): ConvMessage[] {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return []
  }
  const type = obj.type as string | undefined
  if (type !== 'user' && type !== 'assistant') return []
  const uuid =
    (obj.uuid as string | undefined) ||
    ((obj.message as Record<string, unknown> | undefined)?.id as string | undefined) ||
    `gen:${Math.random().toString(36).slice(2)}`
  const tsRaw = obj.timestamp as string | undefined
  const ts = tsRaw ? new Date(tsRaw).getTime() : Date.now()
  const msg = obj.message as Record<string, unknown> | undefined
  const content = msg?.content
  const out: ConvMessage[] = []

  if (typeof content === 'string') {
    if (content.trim()) out.push({ id: uuid, role: type, text: content, ts })
    return out
  }
  if (!Array.isArray(content)) return out

  let idx = 0
  for (const c of content as Array<Record<string, unknown>>) {
    const t = c.type as string | undefined
    const subId = `${uuid}:${idx++}`
    if (t === 'text' && typeof c.text === 'string' && c.text.trim()) {
      out.push({ id: subId, role: type, text: c.text, ts })
    } else if (t === 'tool_use' && typeof c.name === 'string') {
      const input =
        typeof c.input === 'object' && c.input
          ? Object.entries(c.input as Record<string, unknown>)
              .slice(0, 6)
              .map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 200)}`)
              .join('\n')
          : ''
      out.push({ id: subId, role: 'tool_use', text: input, ts, toolName: c.name })
    } else if (t === 'tool_result') {
      const inner = extractTextOnly(c.content)
      if (inner.trim()) {
        out.push({ id: subId, role: 'tool_result', text: inner.slice(0, 2000), ts })
      }
    }
  }
  return out
}

/**
 * User-message text from a chunk of JSONL. `slicedMidLine` drops the first
 * line, which is a fragment whenever the chunk came from a byte offset rather
 * than the start of the file.
 */
export function userMessagesFromTail(text: string, slicedMidLine: boolean): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  for (let i = slicedMidLine ? 1 : 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type !== 'user') continue
    const msg = obj.message as Record<string, unknown> | undefined
    const content = msg?.content
    if (typeof content === 'string') {
      out.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === 'text' && typeof part.text === 'string') out.push(part.text)
      }
    }
  }
  return out
}

/**
 * How many of `prompts` appear among `msgs`. Used to decide which transcript
 * belongs to which PikudClaude session when several share one project folder.
 * Matching is on a 40-char signature so re-wrapping on either side can't break it.
 */
export function scorePrompts(msgs: string[], prompts: string[]): number {
  if (prompts.length === 0 || msgs.length === 0) return 0
  let score = 0
  for (const p of prompts) {
    const q = p.trim()
    if (q.length < 4) continue
    const sig = q.slice(0, 40)
    for (const m of msgs) {
      if (m.includes(sig) || sig.includes(m.trim().slice(0, 40))) {
        score++
        break
      }
    }
  }
  return score
}
