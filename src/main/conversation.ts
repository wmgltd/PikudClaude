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

export interface WatchTarget {
  cwd: string
  // tmux session name — kept for potential future use; current resolver
  // doesn't depend on it.
  tmuxName?: string
  // This session's 0-indexed position among PikudClaude sessions sharing
  // the same cwd, ordered by createdAt ascending. Used for chronological
  // JSONL pairing when there's more than one session on the cwd.
  positionInCwd: number
  siblingCount: number
}

// ---------- Per-session JSONL resolution ----------
//
// ~/.claude/projects/<flattened-cwd>/ holds one .jsonl per Claude session.
// When the user opens two PikudClaude sessions on the same cwd, both have
// the same project folder, and a naive "most recently modified" lookup
// makes both panels show the same (newer) JSONL.
//
// We tried two approaches that don't work:
//   1. lsof — Claude doesn't keep its .jsonl open between writes
//      (open → append → close per message), so lsof returns nothing.
//   2. CLAUDE_CODE_SESSION_ID env var — this is INHERITED from the parent
//      shell, so every Claude process under PikudClaude inherits the same
//      stale value (the one in the env when PikudClaude was launched).
//      It does NOT reflect the real session id Claude is using.
//
// What works: chronological pairing. JSONLs are created when Claude starts.
// If there are N PikudClaude sessions sharing this cwd (ordered by their
// createdAt), the N most recent JSONLs (ordered by first-message timestamp)
// are theirs — Nth session ↔ Nth JSONL. This is a heuristic but handles
// the common case (one Claude per session, no /clear) reliably.

function readFirstTimestamp(path: string): number | null {
  // Read up to the first ~4KB and parse the first JSON line for its
  // timestamp. Cheap probe — we only need this once per JSONL.
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, 4096, 0)
    closeSync(fd)
    const str = buf.toString('utf8', 0, n)
    const firstLine = str.split('\n')[0]
    if (!firstLine.trim()) return null
    const obj = JSON.parse(firstLine) as { timestamp?: string }
    if (typeof obj.timestamp !== 'string') return null
    const ts = new Date(obj.timestamp).getTime()
    return Number.isFinite(ts) ? ts : null
  } catch {
    return null
  }
}

interface JsonlInfo {
  path: string
  firstTs: number
}

function listJsonlsByFirstTs(dir: string): JsonlInfo[] {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    const out: JsonlInfo[] = []
    for (const f of files) {
      const full = join(dir, f)
      const firstTs = readFirstTimestamp(full)
      if (firstTs !== null) out.push({ path: full, firstTs })
    }
    out.sort((a, b) => a.firstTs - b.firstTs)
    return out
  } catch {
    return []
  }
}

function pickJsonlForPosition(
  dir: string,
  position: number,
  siblingCount: number
): string | null {
  if (siblingCount <= 1) return null
  const all = listJsonlsByFirstTs(dir)
  if (all.length === 0) return null
  // Pair the N most recent JSONLs with the N siblings in creation order.
  // If we have fewer JSONLs than siblings (sessions where Claude was never
  // started), the earliest siblings drop off the front of the pairing.
  const tail = all.slice(-siblingCount)
  // position is 0-indexed in siblings sorted by createdAt ascending.
  const offset = position - (siblingCount - tail.length)
  if (offset < 0 || offset >= tail.length) return null
  return tail[offset].path
}

/**
 * Tail Claude's session JSONL for a given pane and emit incremental events.
 *
 * Tracks byte position + partial-line buffer so each append only re-reads new
 * bytes (not the whole file). Detects file rotation (Claude opens a new
 * .jsonl on /clear) and emits an explicit reset. Uses fs.watch on the dir
 * for low-latency notifications + a 1s polling fallback because dir watchers
 * miss byte-level appends on some platforms.
 */
export function watchConversation(target: WatchTarget, onEvent: EventHandler): () => void {
  const cwd = target.cwd
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

  const resolveFile = (): string | null => {
    // If multiple PikudClaude sessions share this cwd, pair them with the
    // JSONLs in the project folder by chronological position. Otherwise
    // (this is the only session on the cwd) just take the most recent
    // JSONL.
    if (target.siblingCount > 1) {
      const paired = pickJsonlForPosition(dir, target.positionInCwd, target.siblingCount)
      if (paired) return paired
    }
    return latestJsonl(dir)
  }

  const reconcile = (): void => {
    if (stopped) return
    const latest = resolveFile()
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
