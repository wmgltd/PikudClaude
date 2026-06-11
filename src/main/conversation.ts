import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadPromptHistory } from './store'

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
  // PikudClaude session id — used to look up this session's prompt history
  // and match it against candidate JSONLs in the project folder.
  sessionId: string
  // Number of PikudClaude sessions currently on this cwd. When 1, the
  // resolver shortcuts to most-recent JSONL.
  siblingCount: number
}

// ---------- Per-session JSONL resolution ----------
//
// ~/.claude/projects/<flattened-cwd>/ holds one .jsonl per Claude session.
// When the user opens two PikudClaude sessions on the same cwd, both have
// the same project folder, and a naive "most recently modified" lookup
// makes both panels show the same (newer) JSONL.
//
// Attempts that didn't work:
//   1. lsof — Claude doesn't keep its .jsonl open between writes.
//   2. CLAUDE_CODE_SESSION_ID env var — inherited from PikudClaude's parent
//      shell, NOT updated to Claude's real session id.
//   3. Chronological pairing of sessions ↔ JSONLs by createdAt — breaks
//      when the folder has stale JSONLs from sessions PikudClaude no longer
//      knows about.
//
// What does work: PikudClaude already records what the user typed in each
// session (promptHistory.json). The JSONL Claude writes contains those
// same prompts as user messages. We match: for each candidate JSONL,
// count how many of the session's prompts appear in the file, pick the
// JSONL with the most matches. Reliable as long as the user has typed at
// least one prompt — and the user wouldn't open the conv panel for a
// session that had no activity in the first place.

function tailUserMessages(jsonlPath: string, maxBytes: number = 512 * 1024): string[] {
  // Read up to the last `maxBytes` of the file, parse each line, return
  // user-message text. Sufficient for prompt-matching against the user's
  // recent prompts — they live near the end of the JSONL.
  try {
    const sz = statSync(jsonlPath).size
    const start = Math.max(0, sz - maxBytes)
    const len = sz - start
    const buf = Buffer.alloc(len)
    const fd = openSync(jsonlPath, 'r')
    readSync(fd, buf, 0, len, start)
    closeSync(fd)
    const out: string[] = []
    const lines = buf.toString('utf8').split('\n')
    // Drop the first line if we sliced into the middle of one.
    const startIdx = start > 0 ? 1 : 0
    for (let i = startIdx; i < lines.length; i++) {
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
  } catch {
    return []
  }
}

function scoreJsonlAgainstPrompts(jsonlPath: string, prompts: string[]): number {
  if (prompts.length === 0) return 0
  const msgs = tailUserMessages(jsonlPath)
  if (msgs.length === 0) return 0
  let score = 0
  for (const p of prompts) {
    const q = p.trim()
    if (q.length < 4) continue
    // Use a short signature (first 40 chars) so wrapping/whitespace in
    // either side doesn't break the match.
    const sig = q.slice(0, 40)
    let matched = false
    for (const m of msgs) {
      if (m.includes(sig) || sig.includes(m.trim().slice(0, 40))) {
        matched = true
        break
      }
    }
    if (matched) score++
  }
  return score
}

function pickJsonlByPromptMatch(dir: string, sessionId: string): string | null {
  try {
    const history = loadPromptHistory()
    const prompts = (history[sessionId] ?? [])
      .map((e) => e.text)
      .filter((t) => typeof t === 'string' && t.trim().length >= 4)
      .slice(0, 8)
    if (prompts.length === 0) return null
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f))
    let bestPath: string | null = null
    let bestScore = 0
    for (const path of files) {
      const score = scoreJsonlAgainstPrompts(path, prompts)
      if (score > bestScore) {
        bestScore = score
        bestPath = path
      }
    }
    return bestScore > 0 ? bestPath : null
  } catch {
    return null
  }
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

  // We need to pick the JSONL once on first resolve and then stick with it
  // until the directory clearly changes (e.g., the file we picked stops
  // existing). Re-doing the prompt-match every tick would re-scan candidate
  // JSONLs constantly. Cache the chosen path.
  let pickedFile: string | null = null
  const resolveFile = (): string | null => {
    if (pickedFile && existsSync(pickedFile)) return pickedFile
    if (target.siblingCount > 1) {
      const matched = pickJsonlByPromptMatch(dir, target.sessionId)
      if (matched) {
        pickedFile = matched
        return matched
      }
    }
    pickedFile = latestJsonl(dir)
    return pickedFile
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
