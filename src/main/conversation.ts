import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { loadPromptHistory } from './store'
import {
  parseLine,
  projectDirName,
  scorePrompts,
  userMessagesFromTail,
  type ConvMessage,
  type ConvRole
} from '../shared/transcript'

export type { ConvMessage, ConvRole }

// Claude transcripts are unbounded — a long-lived project routinely reaches
// 100 MB+ in a single .jsonl. Reading one whole, synchronously, on the main
// process (which is what this module used to do) blocked Electron for tens of
// seconds: keystrokes queued instead of reaching the pty and then all flushed
// at once, and the panel that was supposed to show the conversation got tens of
// thousands of bubbles it renders unvirtualized. Bound both ends — the tail is
// the only part a conversation panel is about.
const INITIAL_TAIL_BYTES = 2 * 1024 * 1024
const MAX_INITIAL_MESSAGES = 400

/** Read `length` bytes from `start` without blocking the event loop. */
async function readRange(path: string, start: number, length: number): Promise<string> {
  if (length <= 0) return ''
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

export type ConvEvent =
  // `truncated` means the transcript was longer than what we loaded — the
  // panel says so rather than pretending this is the whole conversation.
  | { type: 'initial'; messages: ConvMessage[]; truncated: boolean }
  | { type: 'append'; messages: ConvMessage[] }
  | { type: 'reset' }
  | { type: 'sync_complete' }

/**
 * Map a working directory to the folder Claude Code keeps its transcripts in.
 *
 * Claude flattens the cwd into one folder name by replacing every character
 * that is not a letter or a digit with '-'. We used to substitute only '/',
 * which silently broke every session whose path contained anything else: a
 * space ("…/Geektime APP"), a punctuation mark ("…/!static-websites"), a dot or
 * an underscore. Those resolved to a directory that does not exist, so the
 * conversation panel reported "no messages yet" forever while the terminal was
 * plainly full of conversation.
 *
 * The rule is confirmed against the real store: across every folder in
 * ~/.claude/projects, the only non-alphanumeric character that appears is '-'.
 * The leading slash becomes the leading '-' that Claude keeps.
 */
export function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', projectDirName(cwd))
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

/** Non-blocking twin of latestJsonl, for the live watcher path. */
async function latestJsonlAsync(dir: string): Promise<string | null> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return null
  }
  let best: string | null = null
  let bestMtime = -Infinity
  await Promise.all(
    files.map(async (f) => {
      const full = join(dir, f)
      try {
        const mt = (await stat(full)).mtimeMs
        if (mt > bestMtime) {
          bestMtime = mt
          best = full
        }
      } catch {
        /* skip */
      }
    })
  )
  return best
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

const MATCH_TAIL_BYTES = 512 * 1024

function tailUserMessages(jsonlPath: string, maxBytes: number = MATCH_TAIL_BYTES): string[] {
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
    return userMessagesFromTail(buf.toString('utf8'), start > 0)
  } catch {
    return []
  }
}

async function tailUserMessagesAsync(jsonlPath: string): Promise<string[]> {
  try {
    const sz = (await stat(jsonlPath)).size
    const start = Math.max(0, sz - MATCH_TAIL_BYTES)
    const text = await readRange(jsonlPath, start, sz - start)
    return userMessagesFromTail(text, start > 0)
  } catch {
    return []
  }
}

/** The session's most recent prompts, as match signatures. */
function sessionPrompts(sessionId: string): string[] {
  try {
    const history = loadPromptHistory()
    return (history[sessionId] ?? [])
      .map((e) => e.text)
      .filter((t) => typeof t === 'string' && t.trim().length >= 4)
      .slice(0, 8)
  } catch {
    return []
  }
}

function pickJsonlByPromptMatch(dir: string, sessionId: string): string | null {
  try {
    const prompts = sessionPrompts(sessionId)
    if (prompts.length === 0) return null
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f))
    let bestPath: string | null = null
    let bestScore = 0
    for (const path of files) {
      const score = scorePrompts(tailUserMessages(path), prompts)
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

/** Non-blocking twin of pickJsonlByPromptMatch, for the live watcher path. */
async function pickJsonlByPromptMatchAsync(
  dir: string,
  sessionId: string
): Promise<string | null> {
  const prompts = sessionPrompts(sessionId)
  if (prompts.length === 0) return null
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f))
  } catch {
    return null
  }
  const scored = await Promise.all(
    files.map(async (path) => ({
      path,
      score: scorePrompts(await tailUserMessagesAsync(path), prompts)
    }))
  )
  let bestPath: string | null = null
  let bestScore = 0
  for (const { path, score } of scored) {
    if (score > bestScore) {
      bestScore = score
      bestPath = path
    }
  }
  return bestScore > 0 ? bestPath : null
}

function soleJsonl(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    return files.length === 1 ? join(dir, files[0]) : null
  } catch {
    return null
  }
}

/**
 * Resolve the Claude Code session id (the .jsonl basename) that a PikudClaude
 * session was running in `cwd` — used to rebuild `claude --resume <id>` when a
 * session is resurrected after its tmux server died (e.g. a Mac reboot).
 *
 * Primary signal is the same prompt-match the conversation panel uses, so it
 * stays correct even when several PikudClaude sessions share one cwd. Falls
 * back to the sole JSONL only when the folder is unambiguous. Returns null when
 * it can't confidently pick one — callers should then start a fresh session
 * rather than resume the wrong conversation.
 */
export function resolveClaudeSessionId(cwd: string, sessionId: string): string | null {
  const dir = projectDir(cwd)
  const chosen = pickJsonlByPromptMatch(dir, sessionId) ?? soleJsonl(dir)
  if (!chosen) return null
  return basename(chosen).replace(/\.jsonl$/, '')
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

  // Set by the fromStart drain when it skipped past the head of the file.
  let skippedHead = false

  const drain = async (path: string, fromStart: boolean): Promise<ConvMessage[]> => {
    let s
    try {
      s = await stat(path)
    } catch {
      return []
    }
    // Both the first read and a post-truncation re-read start from the tail
    // rather than byte 0 — see INITIAL_TAIL_BYTES.
    let slicedMidLine = false
    if (fromStart || s.size < position) {
      position = Math.max(0, s.size - INITIAL_TAIL_BYTES)
      slicedMidLine = position > 0
      skippedHead = slicedMidLine
      buffer = ''
    }
    if (s.size <= position) return []
    let text: string
    try {
      text = await readRange(path, position, s.size - position)
    } catch {
      return []
    }
    position = s.size
    buffer += text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    // Slicing into the tail almost certainly landed mid-line; that fragment is
    // not valid JSON and would just be dropped by parseLine, but discard it
    // explicitly so the intent is clear.
    if (slicedMidLine) lines.shift()
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
  const resolveFile = async (): Promise<string | null> => {
    if (pickedFile && existsSync(pickedFile)) return pickedFile
    if (target.siblingCount > 1) {
      const matched = await pickJsonlByPromptMatchAsync(dir, target.sessionId)
      if (matched) {
        pickedFile = matched
        return matched
      }
    }
    pickedFile = await latestJsonlAsync(dir)
    return pickedFile
  }

  // Emit the initial backlog, newest-last, capped. `skippedHead` (bytes we
  // never read) and the message cap are both reasons the panel isn't showing
  // the full transcript, so either one flags it as truncated.
  const emitInitial = (all: ConvMessage[]): void => {
    const capped = all.length > MAX_INITIAL_MESSAGES ? all.slice(-MAX_INITIAL_MESSAGES) : all
    onEvent({
      type: 'initial',
      messages: capped,
      truncated: skippedHead || capped.length < all.length
    })
  }

  const reconcileOnce = async (): Promise<void> => {
    const latest = await resolveFile()
    if (stopped) return
    if (!latest) {
      if (!initialSent) {
        onEvent({ type: 'initial', messages: [], truncated: false })
        onEvent({ type: 'sync_complete' })
        initialSent = true
      }
      return
    }
    if (latest !== currentFile) {
      const isFirst = currentFile === null
      currentFile = latest
      const all = await drain(latest, true)
      if (stopped) return
      if (isFirst) {
        emitInitial(all)
        if (!initialSent) {
          onEvent({ type: 'sync_complete' })
          initialSent = true
        }
      } else {
        onEvent({ type: 'reset' })
        emitInitial(all)
      }
      return
    }
    const newMsgs = await drain(currentFile, false)
    if (stopped) return
    if (newMsgs.length > 0) onEvent({ type: 'append', messages: newMsgs })
  }

  // The 1s poll and the directory watcher both call this, and it is now async —
  // without a gate, a slow first drain would let a second run start against a
  // half-updated `position`/`buffer` and duplicate or lose messages. Coalesce
  // overlapping requests into one trailing re-run.
  let running = false
  let queued = false
  const reconcile = (): void => {
    if (stopped) return
    if (running) {
      queued = true
      return
    }
    running = true
    void reconcileOnce()
      .catch(() => undefined)
      .finally(() => {
        running = false
        if (queued && !stopped) {
          queued = false
          reconcile()
        }
      })
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
