import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type ConvRole = 'user' | 'assistant' | 'tool_use' | 'tool_result'

export interface ConvMessage {
  id: string
  role: ConvRole
  text: string
  ts: number
  toolName?: string
}

export type ConvEvent =
  | { type: 'initial'; messages: ConvMessage[] }
  | { type: 'append'; messages: ConvMessage[] }
  | { type: 'reset' }
  | { type: 'sync_complete' }

function projectDir(cwd: string): string {
  // Claude flattens the cwd to a single folder name by swapping every '/' for
  // '-'. Trailing slash is dropped first; the leading slash becomes a leading
  // '-' which Claude keeps.
  const normalized = cwd.replace(/\/+$/, '')
  return join(homedir(), '.claude', 'projects', normalized.replace(/\//g, '-'))
}

function latestJsonl(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    if (files.length === 0) return null
    let best = ''
    let bestMtime = -Infinity
    for (const f of files) {
      const full = join(dir, f)
      try {
        const mt = statSync(full).mtimeMs
        if (mt > bestMtime) {
          bestMtime = mt
          best = full
        }
      } catch {
        /* skip */
      }
    }
    return best || null
  } catch {
    return null
  }
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

function parseLine(raw: string): ConvMessage[] {
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

type EventHandler = (event: ConvEvent) => void

/**
 * Tail Claude's session JSONL for a given cwd and emit incremental events.
 *
 * Tracks byte position + partial-line buffer so each append only re-reads new
 * bytes (not the whole file). Detects file rotation (Claude opens a new
 * .jsonl on /clear) and emits an explicit reset. Uses fs.watch on the dir
 * for low-latency notifications + a 1s polling fallback because dir watchers
 * miss byte-level appends on some platforms.
 */
export function watchConversation(cwd: string, onEvent: EventHandler): () => void {
  const dir = projectDir(cwd)
  let currentFile: string | null = null
  let position = 0
  let buffer = ''
  let initialSent = false
  let stopped = false

  const drain = (path: string, fromStart: boolean): ConvMessage[] => {
    let s
    try {
      s = statSync(path)
    } catch {
      return []
    }
    if (fromStart) {
      position = 0
      buffer = ''
    } else if (s.size < position) {
      // truncation — start over
      position = 0
      buffer = ''
    }
    if (s.size === position) return []
    const len = s.size - position
    const buf = Buffer.alloc(len)
    try {
      const fd = openSync(path, 'r')
      readSync(fd, buf, 0, len, position)
      closeSync(fd)
    } catch {
      return []
    }
    position = s.size
    buffer += buf.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    const out: ConvMessage[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      for (const m of parseLine(line)) out.push(m)
    }
    return out
  }

  const reconcile = (): void => {
    if (stopped) return
    const latest = latestJsonl(dir)
    if (!latest) {
      if (!initialSent) {
        onEvent({ type: 'initial', messages: [] })
        onEvent({ type: 'sync_complete' })
        initialSent = true
      }
      return
    }
    if (latest !== currentFile) {
      const isFirst = currentFile === null
      currentFile = latest
      const all = drain(latest, true)
      if (isFirst) {
        onEvent({ type: 'initial', messages: all })
        if (!initialSent) {
          onEvent({ type: 'sync_complete' })
          initialSent = true
        }
      } else {
        onEvent({ type: 'reset' })
        onEvent({ type: 'initial', messages: all })
      }
      return
    }
    const newMsgs = drain(currentFile, false)
    if (newMsgs.length > 0) onEvent({ type: 'append', messages: newMsgs })
  }

  reconcile()

  let dirWatcher: ReturnType<typeof watch> | null = null
  try {
    if (existsSync(dir)) {
      dirWatcher = watch(dir, { persistent: false }, () => reconcile())
    }
  } catch {
    /* dir may not exist yet — polling will pick it up */
  }
  const poll = setInterval(reconcile, 1000)

  return () => {
    stopped = true
    try {
      dirWatcher?.close()
    } catch {
      /* ignore */
    }
    clearInterval(poll)
  }
}
