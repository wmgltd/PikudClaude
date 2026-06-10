import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)

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
  // tmux session name — used to find which .jsonl this specific pane's
  // Claude is writing to, so two PikudClaude sessions on the same cwd
  // don't share the same conversation feed.
  tmuxName?: string
}

// ---------- Per-session JSONL resolution ----------
//
// ~/.claude/projects/<flattened-cwd>/ holds one .jsonl per Claude session.
// When the user opens two PikudClaude sessions on the same cwd, both have
// the same project folder, and a naive "most recently modified" lookup makes
// both panels show the same (newer) JSONL. Real fix: find the Claude process
// running inside this specific tmux pane and read its CLAUDE_CODE_SESSION_ID
// environment variable — Claude embeds its session UUID there, and the JSONL
// filename is `<sessionId>.jsonl`.
//
// (We tried lsof first; turns out Claude doesn't keep the .jsonl file open
// between writes, so lsof comes back empty. The env var is set for the
// lifetime of the process, which is much more reliable.)

// In-memory cache: tmuxName → last seen Claude session id. Lets us still
// resolve the right JSONL after Claude exits or restarts mid-conversation,
// as long as PikudClaude itself stays running.
const sessionIdCache = new Map<string, string>()

async function getPanePid(tmuxName: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('tmux', [
      '-u', 'display-message', '-p', '-t', tmuxName, '#{pane_pid}'
    ])
    const pid = parseInt(stdout.trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

async function getDescendantPids(rootPid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid,ppid'])
    const childrenMap = new Map<number, number[]>()
    const lines = stdout.trim().split('\n').slice(1)
    for (const line of lines) {
      const m = line.trim().split(/\s+/)
      const pid = parseInt(m[0], 10)
      const ppid = parseInt(m[1], 10)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      const arr = childrenMap.get(ppid)
      if (arr) arr.push(pid)
      else childrenMap.set(ppid, [pid])
    }
    const result: number[] = []
    const queue = [rootPid]
    const seen = new Set<number>()
    while (queue.length > 0) {
      const pid = queue.shift()!
      if (seen.has(pid)) continue
      seen.add(pid)
      if (pid !== rootPid) result.push(pid)
      const kids = childrenMap.get(pid)
      if (kids) queue.push(...kids)
    }
    return result
  } catch {
    return []
  }
}

async function readClaudeSessionId(pid: number): Promise<string | null> {
  // BSD `ps eww -p <pid>` dumps the process command followed by its
  // environment, space-separated. macOS only lets you read env of your own
  // processes, which is exactly the case here.
  try {
    const { stdout } = await execFileAsync('ps', ['eww', '-p', String(pid)], {
      timeout: 2500
    })
    const m = stdout.match(/CLAUDE_CODE_SESSION_ID=([0-9a-fA-F-]{36})/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function findJsonlBySessionId(sessionId: string, preferredFolder: string): string | null {
  // Most likely location first: the project folder we already computed from
  // cwd. If Claude was started from a different cwd than the tmux pane (rare
  // but possible), search every folder under ~/.claude/projects/.
  const direct = join(preferredFolder, `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  try {
    const root = join(homedir(), '.claude', 'projects')
    for (const folder of readdirSync(root)) {
      const p = join(root, folder, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    /* projects dir missing — give up */
  }
  return null
}

async function findActiveJsonlForPane(tmuxName: string, cwd: string): Promise<string | null> {
  const folder = projectDir(cwd)
  const panePid = await getPanePid(tmuxName)
  if (panePid !== null) {
    const descendants = await getDescendantPids(panePid)
    for (const pid of descendants) {
      const sessionId = await readClaudeSessionId(pid)
      if (!sessionId) continue
      sessionIdCache.set(tmuxName, sessionId)
      const path = findJsonlBySessionId(sessionId, folder)
      if (path) return path
    }
  }
  // No live Claude — try whatever session id we last saw in this pane.
  const cached = sessionIdCache.get(tmuxName)
  if (cached) {
    const path = findJsonlBySessionId(cached, folder)
    if (path) return path
  }
  return null
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
  const tmuxName = target.tmuxName
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

  const resolveFile = async (): Promise<string | null> => {
    // Prefer the JSONL actually held open by this pane's Claude — distinguishes
    // two sessions on the same cwd. Fall back to most-recent if no Claude is
    // running yet, or if we're on Windows where lsof isn't available.
    if (tmuxName && process.platform !== 'win32') {
      try {
        const fromPane = await findActiveJsonlForPane(tmuxName, cwd)
        if (fromPane) return fromPane
      } catch {
        /* fall through to mtime lookup */
      }
    }
    return latestJsonl(dir)
  }

  const reconcile = async (): Promise<void> => {
    if (stopped) return
    const latest = await resolveFile()
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

  void reconcile()

  let dirWatcher: ReturnType<typeof watch> | null = null
  try {
    if (existsSync(dir)) {
      dirWatcher = watch(dir, { persistent: false }, () => {
        void reconcile()
      })
    }
  } catch {
    /* dir may not exist yet — polling will pick it up */
  }
  const poll = setInterval(() => {
    void reconcile()
  }, 1000)

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
