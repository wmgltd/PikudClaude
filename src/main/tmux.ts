import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { EventEmitter } from 'node:events'
import type {
  SessionMeta,
  CreateSessionOpts,
  ExternalTmuxSession,
  ImportSessionOpts,
  SessionStatus
} from './types'
import { loadSessions, saveSessions, loadCachedTmuxPath, saveCachedTmuxPath } from './store'
import { appendErrorEntry } from './errorLog'
import { resolveClaudeSessionId } from './conversation'
import { detectAwaiting, isShellCommand, pickRotation } from '../shared/paneState'
import type { SessionVitals } from '../shared/vitals'

const execFileAsync = promisify(execFile)

const KNOWN_TMUX_PATHS = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  '/opt/local/bin/tmux'
]

let cachedTmuxBin: string | null = null

function resolveTmuxBin(): string {
  if (cachedTmuxBin) return cachedTmuxBin
  const fromEnv = process.env.TMUX_BIN
  if (fromEnv && existsSync(fromEnv)) {
    cachedTmuxBin = fromEnv
    return fromEnv
  }
  for (const p of KNOWN_TMUX_PATHS) {
    if (existsSync(p)) {
      cachedTmuxBin = p
      return p
    }
  }
  // A previous launch already paid the login-shell cost — reuse its answer
  // if the binary is still there.
  const persisted = loadCachedTmuxPath()
  if (persisted && existsSync(persisted)) {
    cachedTmuxBin = persisted
    return persisted
  }
  try {
    const out = execSync(`/bin/bash -lc 'command -v tmux'`, {
      encoding: 'utf8',
      timeout: 3000
    }).trim()
    if (out && existsSync(out)) {
      cachedTmuxBin = out
      saveCachedTmuxPath(out)
      return out
    }
  } catch {
    /* fall through to error below */
  }
  throw new Error(
    'tmux not found. Install it (e.g. `brew install tmux`) or set TMUX_BIN to its absolute path.'
  )
}

const NATIVE_PREFIX = 'pikudclaude-'

const nativeTmuxName = (id: string) => `${NATIVE_PREFIX}${id}`

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(resolveTmuxBin(), ['-u', ...args])
  return stdout
}

async function tmuxSessionExistsByName(tmuxName: string): Promise<boolean> {
  try {
    await execFileAsync(resolveTmuxBin(), ['-u', 'has-session', '-t', `=${tmuxName}`])
    return true
  } catch {
    return false
  }
}

interface AttachedPty {
  pty: IPty
  cols: number
  rows: number
}

interface DataSample {
  ts: number
  size: number
}

const STATUS_WINDOW_MS = 1500
const STATUS_BYTE_THRESHOLD = 200
// Attaching to a tmux session causes tmux + Claude's TUI to repaint the
// whole screen, which arrives as a burst of bytes. Drop the bytes that
// arrive in this window so they don't pollute dataWindow and get misread
// as "working".
const ATTACH_GRACE_MS = 2500
const AWAITING_POLL_MS = 2000
// `capture-pane` costs one subprocess per session, and this poll runs every 2s.
// Probing every session meant ~11 forks/second at 22 sessions — noticeable on a
// healthy Mac and actively harmful on one that is already swapping, where each
// fork has to page in a process image. Attached sessions (the ones the user can
// actually see) are always probed; the rest rotate through a few per tick, so
// the fork rate stays bounded no matter how many sessions exist.
//
// Cost: a background session's "awaiting" badge can lag by
// ceil(unattachedCount / BACKGROUND_PROBES_PER_TICK) * AWAITING_POLL_MS —
// about 8s at 17 background sessions, versus 2s before. That is well inside
// human reaction time for a "Claude needs you" nudge.
const BACKGROUND_PROBES_PER_TICK = 4
// How long after tmux last reported pane output we keep calling a session
// 'working'. #{window_activity} has one-second resolution and we sample it
// every AWAITING_POLL_MS, so this has to cover a couple of polls; erring long
// also stops the dot flickering while Claude pauses between tool calls.
const ACTIVITY_WORKING_WINDOW_MS = 6000

export class TmuxManager extends EventEmitter {
  private sessions: SessionMeta[] = []
  private attached = new Map<string, AttachedPty>()
  private attachedAt = new Map<string, number>()
  private dataWindow = new Map<string, DataSample[]>()
  private lastEmittedStatus = new Map<string, SessionStatus>()
  private awaitingMap = new Map<string, boolean>()
  private paneCommandMap = new Map<string, string>()
  private statusTimer: NodeJS.Timeout | null = null
  private awaitingTimer: NodeJS.Timeout | null = null
  // Round-robin position for the background capture-pane rotation.
  private awaitingProbeCursor = 0
  // tmux's #{window_activity} (epoch seconds) as of the last poll, and our own
  // clock reading of when we last saw it advance. Two maps because tmux's value
  // is coarse and only meaningful as a change detector.
  private lastWindowActivity = new Map<string, number>()
  private activityChangedAt = new Map<string, number>()
  private resurrecting = new Map<string, Promise<void>>()
  private attaching = new Map<string, Promise<void>>()
  private globalBindingsApplied = false
  private async ensureMouseAndClipboard(tmuxName: string): Promise<void> {
    try {
      await tmux('set-option', '-t', tmuxName, 'mouse', 'on')
    } catch {
      /* tmux too old or session gone — silently skip */
    }
    try {
      await tmux('set-option', '-t', tmuxName, 'set-clipboard', 'on')
    } catch {
      /* not supported */
    }
    await this.ensureGlobalBindings()
  }

  private async ensureGlobalBindings(): Promise<void> {
    if (this.globalBindingsApplied) return
    this.globalBindingsApplied = true
    // Smart mouse-wheel. If the foreground app has its OWN mouse mode on
    // (e.g. Claude Code 2.x running in its alt-screen), forward the wheel to
    // it via `send-keys -M` so it scrolls its own view. Only fall back to
    // tmux copy-mode for plain shells (no app mouse mode).
    //
    // The previous binding entered `copy-mode -e` UNCONDITIONALLY, which
    // hijacked the wheel from such apps and dropped them into an empty
    // copy-mode — alt-screen panes have no scrollback (history_size 0), so the
    // pane got stuck in copy-mode at scroll position 0 and nothing scrolled.
    // WheelDown only runs `scroll-down` when actually in copy-mode, otherwise
    // it would print "not in a mode" in a plain shell.
    try {
      await tmux(
        'bind-key', '-T', 'root', 'WheelUpPane',
        'if-shell', '-F', '-t', '=', '#{mouse_any_flag}',
        'send-keys -M',
        'copy-mode -e ; send-keys -X -N 3 scroll-up'
      )
    } catch {
      /* ignore */
    }
    try {
      await tmux(
        'bind-key', '-T', 'root', 'WheelDownPane',
        'if-shell', '-F', '-t', '=', '#{mouse_any_flag}',
        'send-keys -M',
        "if-shell -F -t = '#{pane_in_mode}' 'send-keys -X -N 3 scroll-down'"
      )
    } catch {
      /* ignore */
    }
    // Bind in BOTH copy-mode tables. tmux defaults to emacs (`copy-mode`)
    // unless `mode-keys vi` is set globally; binding only copy-mode-vi would
    // let the default `copy-selection-and-cancel` fire on release, which
    // exits copy-mode AND clears the selection. We use the two-step form so
    // the visible selection survives (copy-pipe-no-clear actually clears the
    // visual in tmux 3.6 despite the name): copy-selection-no-clear keeps the
    // visual highlight, and save-buffer | pbcopy bridges the most-recent
    // tmux buffer to the system clipboard sequentially (no `-b`, so it
    // completes before tmux moves on and never races the buffer write).
    for (const table of ['copy-mode', 'copy-mode-vi']) {
      try {
        // Native terminal behaviour: copy to clipboard, exit copy-mode, clear
        // the visual selection. Matches macOS Terminal / iTerm — release the
        // mouse and you're back in the live screen, ready to type. We can't
        // keep the selection visible across release without abandoning
        // tmux's `-M` mouse drag entirely (its state machine wipes the
        // visual on mouseup), so we don't try.
        await tmux(
          'bind-key', '-T', table, 'MouseDragEnd1Pane',
          'send-keys -X copy-pipe-and-cancel "pbcopy"'
        )
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * True iff the session's pane is currently in tmux copy-mode. The renderer
   * uses this to decide whether a typed key needs a leading `q` to exit
   * copy-mode — but ONLY when tmux actually entered it (plain shells), never
   * when the wheel was forwarded to a mouse-mode app (Claude), where the pane
   * is NOT in copy-mode and a stray `q` would land in the app's input.
   */
  async isInCopyMode(id: string): Promise<boolean> {
    const s = this.getSession(id)
    if (!s) return false
    try {
      const out = await tmux('display-message', '-p', '-t', s.tmuxName, '#{pane_in_mode}')
      return out.trim() === '1'
    } catch {
      return false
    }
  }

  async init(): Promise<void> {
    const stored = loadSessions()
    // Probe all sessions in parallel — this runs before the window is created
    // (index.ts awaits init()), so N serial `tmux has-session` subprocesses
    // would directly delay first paint at N sessions.
    await Promise.all(
      stored.map(async (s) => {
        s.tmuxName = s.tmuxName ?? nativeTmuxName(s.id)
        if (await tmuxSessionExistsByName(s.tmuxName)) {
          s.dead = false
        } else {
          // tmux server was killed (e.g. Mac reboot) — keep the metadata so the
          // user doesn't lose their project list. attach() will resurrect on demand.
          s.dead = true
        }
      })
    )
    this.sessions = stored
    saveSessions(this.sessions)
    await this.reapOrphans()
    this.startStatusTimer()
    // Kick off an immediate probe so every restored session has a status
    // ready to display — without this the sidebar would show stale badges
    // until the first awaiting/status tick fires.
    void this.tickAwaiting().then(() => this.tickStatuses())
  }

  /**
   * Kill leaked native tmux sessions — ones we created (NATIVE_PREFIX) that are
   * no longer tracked in sessions.json. They get orphaned by a crash mid-create,
   * a stranded duplicate-guard, or a store rewrite, and each keeps a live pane
   * (a `claude` process) holding a PTY. macOS caps PTYs at kern.tty.ptmx_max
   * (~511); once orphans push the system over that ceiling, `tmux new-session`
   * fails with "fork failed: Device not configured" / "posix_spawnp failed" and
   * NO new session can open. Reaping on startup keeps the leak from accumulating.
   * Never touches imported/external sessions — those don't carry NATIVE_PREFIX.
   */
  private async reapOrphans(): Promise<void> {
    let raw: string
    try {
      raw = await tmux('list-sessions', '-F', '#{session_name}')
    } catch {
      return // no server or no sessions — nothing to reap
    }
    const tracked = new Set(this.sessions.map((s) => s.tmuxName))
    const orphans = raw
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.startsWith(NATIVE_PREFIX) && !tracked.has(n))
    if (orphans.length === 0) return
    for (const name of orphans) {
      try {
        await tmux('kill-session', '-t', name)
      } catch {
        /* already gone — ignore */
      }
    }
    appendErrorEntry({
      source: 'main',
      kind: 'tmux:reaped-orphans',
      message: `reaped ${orphans.length} orphaned tmux session(s)`,
      context: { orphans }
    })
  }

  private async resurrect(s: SessionMeta): Promise<void> {
    // Concurrent attach() calls (e.g. double-renders) must share one tmux
    // new-session invocation — otherwise the second one errors "duplicate session".
    const inflight = this.resurrecting.get(s.id)
    if (inflight) return inflight
    const job = this.spawnFreshTmux(s).finally(() => this.resurrecting.delete(s.id))
    this.resurrecting.set(s.id, job)
    return job
  }

  private async spawnFreshTmux(s: SessionMeta): Promise<void> {
    if (s.imported) {
      throw new Error(
        `Imported session "${s.name}" can't be auto-resurrected — re-import it from an existing tmux session.`
      )
    }
    const lang = process.env.LANG || 'en_US.UTF-8'
    const lcAll = process.env.LC_ALL || lang
    const cwd = s.cwd && existsSync(s.cwd) ? s.cwd : process.env.HOME || '/'
    await tmux(
      'new-session',
      '-d',
      '-s', s.tmuxName,
      '-c', cwd,
      '-e', `LANG=${lang}`,
      '-e', `LC_ALL=${lcAll}`,
      '-e', `LC_CTYPE=${lcAll}`,
      '-x', '200',
      '-y', '50'
    )
    const startCommand = this.resurrectCommandFor(s)
    if (startCommand) {
      await tmux('send-keys', '-t', s.tmuxName, startCommand, 'Enter')
    }
    s.dead = false
    saveSessions(this.sessions)
  }

  // A session is only ever resurrected because its tmux server died out from
  // under it (e.g. a Mac reboot). Re-running the raw `claude` initialCommand
  // would drop the user into an empty conversation; rewrite it to
  // `claude --resume <id>` so the pre-reboot conversation comes back. Only
  // touches Claude commands, preserves any extra flags, and no-ops back to the
  // original command when we can't confidently resolve the session's JSONL.
  private resurrectCommandFor(s: SessionMeta): string | undefined {
    const cmd = s.initialCommand
    if (!cmd || !s.cwd) return cmd
    if (!/^\s*claude(\s|$)/.test(cmd)) return cmd
    if (/(^|\s)(--resume|-r|--continue|-c)(\s|$)/.test(cmd)) return cmd
    const id = resolveClaudeSessionId(s.cwd, s.id)
    if (!id) return cmd
    return cmd.replace(/^(\s*claude)(?=\s|$)/, `$1 --resume ${id}`)
  }

  private startStatusTimer(): void {
    if (this.statusTimer) return
    this.statusTimer = setInterval(() => this.tickStatuses(), 400)
    this.awaitingTimer = setInterval(() => this.tickAwaiting(), AWAITING_POLL_MS)
  }

  /**
   * Force an immediate status refresh — used after macOS wake-from-sleep,
   * where the pollers were paused and tmux may have killed sessions while
   * the system was suspended.
   */
  async refreshAfterResume(): Promise<void> {
    // Re-check each session against tmux truth — in BOTH directions.
    // After wake-from-sleep, tmux server may have been killed (mark alive
    // sessions dead), OR a session that we'd flagged dead may have come
    // back (e.g. resurrected by Claude Code itself, or because we
    // mis-detected it as dead earlier). Without resurrecting flipping
    // dead→alive, the sidebar would show stale gray status icons forever.
    let mutated = false
    for (const s of this.sessions) {
      try {
        const exists = await tmuxSessionExistsByName(s.tmuxName)
        if (exists && s.dead) {
          s.dead = false
          mutated = true
        } else if (!exists && !s.dead) {
          s.dead = true
          mutated = true
        }
      } catch {
        /* ignore — treat as unchanged, next tick will retry */
      }
    }
    if (mutated) saveSessions(this.sessions)
    await this.tickAwaiting()
    this.tickStatuses()
  }

  private tickStatuses(): void {
    const now = Date.now()
    // Compute status for every alive session, attached or not.
    //
    // 'working' used to require an attached pty, because the byte-flow window
    // is the only signal a pty gives us. But only MAX_MOUNTED (5) sessions are
    // ever attached, so every other session showed green "idle — waiting for
    // you" the entire time Claude was actually working in it. That is the exact
    // inverse of the truth, on the majority of sessions.
    //
    // tmux's #{window_activity} fixes it: it advances whenever the pane
    // produces output and stands still when it doesn't, it works with no client
    // attached, and — verified against a repainting alt-screen app, which is
    // what Claude Code is — it tracks alt-screen redraws too. We already fetch
    // it in the same single `list-panes -a` call tickAwaiting makes, so this
    // costs nothing.
    const aliveIds = new Set(this.sessions.filter((s) => !s.dead).map((s) => s.id))
    for (const id of aliveIds) {
      const isAttached = this.attached.has(id)
      const samples = this.dataWindow.get(id) ?? []
      const recent = samples.filter((s) => now - s.ts < STATUS_WINDOW_MS)
      if (recent.length !== samples.length) this.dataWindow.set(id, recent)
      const totalBytes = recent.reduce((sum, s) => sum + s.size, 0)
      const cmd = this.paneCommandMap.get(id) ?? ''
      const claudeRunning = !isShellCommand(cmd)
      const outputSeenAt = this.activityChangedAt.get(id) ?? 0
      const producingOutput = now - outputSeenAt < ACTIVITY_WORKING_WINDOW_MS
      let status: SessionStatus
      if (this.awaitingMap.get(id)) status = 'awaiting'
      else if (!claudeRunning) status = 'shell'
      else if ((isAttached && totalBytes > STATUS_BYTE_THRESHOLD) || producingOutput)
        status = 'working'
      else status = 'idle'
      if (this.lastEmittedStatus.get(id) !== status) {
        this.lastEmittedStatus.set(id, status)
        this.emit('status', id, status)
      }
    }
    // Dead sessions broadcast 'detached' once then drop out of the map.
    for (const id of this.lastEmittedStatus.keys()) {
      if (!aliveIds.has(id)) {
        this.lastEmittedStatus.set(id, 'detached')
        this.emit('status', id, 'detached')
        this.lastEmittedStatus.delete(id)
      }
    }
  }

  private async tickAwaiting(): Promise<void> {
    // Probe every alive session in parallel — gives us awaiting state +
    // current pane command for both attached and unattached sessions, so
    // tickStatuses can render accurate badges sidebar-wide without the user
    // needing to open each session first.
    const alive = this.sessions.filter((s) => !s.dead)
    if (alive.length === 0) return
    // Fetch every pane's current command in ONE subprocess (`list-panes -a`)
    // instead of one `display-message` per session — at N sessions this drops
    // the per-tick spawn count from 2N to N+1. Same data, just batched.
    const cmdByName = new Map<string, string>()
    const activityByName = new Map<string, number>()
    try {
      // Filter to the ACTIVE pane of the ACTIVE window: without it, a session
      // with multiple windows/panes maps to whichever pane tmux lists LAST —
      // e.g. a stray shell window would mask the Claude pane the user is
      // actually looking at (wrong 'shell' status + skipped awaiting probe).
      const { stdout } = await execFileAsync(resolveTmuxBin(), [
        '-u', 'list-panes', '-a',
        '-f', '#{&&:#{window_active},#{pane_active}}',
        '-F', '#{session_name}\t#{pane_current_command}\t#{window_activity}'
      ])
      for (const line of stdout.split('\n')) {
        const [name, cmd, activity] = line.split('\t')
        if (!name) continue
        if (cmd !== undefined) cmdByName.set(name, cmd.trim())
        const secs = Number(activity)
        if (Number.isFinite(secs) && secs > 0) activityByName.set(name, secs)
      }
    } catch {
      /* list-panes failed — keep previous paneCommandMap values */
    }

    // Note when each session's output clock last moved. tickStatuses turns
    // "moved recently" into the amber working dot; see the comment there.
    const nowMs = Date.now()
    for (const s of alive) {
      const seen = activityByName.get(s.tmuxName)
      if (seen === undefined) continue
      const prev = this.lastWindowActivity.get(s.id)
      if (prev === undefined) {
        // First observation is a baseline, not evidence of activity — without
        // this every session would flash 'working' on launch.
        this.lastWindowActivity.set(s.id, seen)
        continue
      }
      if (seen > prev) {
        this.lastWindowActivity.set(s.id, seen)
        this.activityChangedAt.set(s.id, nowMs)
      }
    }
    // Partition first, spawn second. `list-panes -a` above already gave us
    // every pane's command in ONE subprocess, so deciding who needs a
    // capture-pane is free.
    const needsProbe: SessionMeta[] = []
    for (const s of alive) {
      const cmd = cmdByName.get(s.tmuxName)
      if (cmd !== undefined) this.paneCommandMap.set(s.id, cmd)
      // "awaiting" is a Claude prompt state — a plain shell never shows one.
      // Skip the (heavier) capture-pane for shell panes; that's where most of
      // the per-tick subprocess cost goes when sessions sit at a shell. A
      // session mid-transition is corrected on the next tick (2s).
      if (cmd !== undefined && isShellCommand(cmd)) {
        this.awaitingMap.set(s.id, false)
        continue
      }
      needsProbe.push(s)
    }

    // Attached sessions are on screen, so they get probed every tick. Everything
    // else takes turns — see BACKGROUND_PROBES_PER_TICK.
    const foreground = needsProbe.filter((s) => this.attached.has(s.id))
    const background = needsProbe.filter((s) => !this.attached.has(s.id))
    const { picked: rotation, nextCursor } = pickRotation(
      background,
      this.awaitingProbeCursor,
      BACKGROUND_PROBES_PER_TICK
    )
    this.awaitingProbeCursor = nextCursor

    await Promise.all(
      [...foreground, ...rotation].map(async (s) => {
        try {
          const content = await this.capturePaneText(s.tmuxName, 30)
          this.awaitingMap.set(s.id, detectAwaiting(content))
        } catch {
          /* capture failed; leave previous value */
        }
      })
    )
  }

  private async capturePaneText(tmuxName: string, lines = 30): Promise<string> {
    const { stdout } = await execFileAsync(resolveTmuxBin(), [
      '-u',
      'capture-pane',
      '-t', tmuxName,
      '-p',
      '-S', `-${lines}`
    ])
    return stdout
  }

  async captureSnapshot(id: string, lines = 50): Promise<string> {
    const s = this.getSession(id)
    if (!s) throw new Error(`session ${id} not found`)
    return this.capturePaneText(s.tmuxName, lines)
  }

  async captureLive(id: string): Promise<string> {
    const s = this.getSession(id)
    if (!s) return ''
    try {
      const { stdout } = await execFileAsync(resolveTmuxBin(), [
        '-u',
        'capture-pane',
        '-t', s.tmuxName,
        '-p'
      ])
      return stdout
    } catch {
      return ''
    }
  }

  /**
   * Per-session idle time and resident memory.
   *
   * Exists because "which of these 22 sessions can I close?" was a question the
   * app could answer but didn't — every live session holds a Claude Code
   * process, and on a memory-constrained machine that is the difference between
   * working and thrashing. Three subprocesses total regardless of session count,
   * so it is safe to poll on a slow timer.
   *
   * `rssMB` is resident memory only. It UNDERSTATES a swapping machine badly,
   * where most of a backgrounded process has been paged out — it ranks sessions
   * against each other honestly, but don't read it as "this is what I get back".
   */
  async getVitals(): Promise<SessionVitals[]> {
    const activityByName = new Map<string, number>()
    const pidsByName = new Map<string, number[]>()
    try {
      const [act, panes] = await Promise.all([
        tmux('list-sessions', '-F', '#{session_name}\t#{session_activity}'),
        tmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}')
      ])
      for (const line of act.split('\n')) {
        const [name, ts] = line.split('\t')
        if (name && ts) activityByName.set(name, Number(ts) * 1000)
      }
      for (const line of panes.split('\n')) {
        const [name, pid] = line.split('\t')
        if (!name || !pid) continue
        const list = pidsByName.get(name) ?? []
        list.push(Number(pid))
        pidsByName.set(name, list)
      }
    } catch {
      return []
    }

    // One `ps` for the whole machine, then sum each pane's process subtree —
    // the Claude process is a grandchild of the pane's shell, not the pane pid.
    const children = new Map<number, number[]>()
    const rss = new Map<number, number>()
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-Ao', 'pid=,ppid=,rss='])
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 3) continue
        const pid = Number(parts[0])
        const ppid = Number(parts[1])
        if (!pid) continue
        rss.set(pid, Number(parts[2]) || 0)
        const sibs = children.get(ppid) ?? []
        sibs.push(pid)
        children.set(ppid, sibs)
      }
    } catch {
      /* no memory figures; idle times are still useful */
    }
    const subtreeKB = (pid: number, seen = new Set<number>()): number => {
      if (seen.has(pid)) return 0
      seen.add(pid)
      let total = rss.get(pid) ?? 0
      for (const c of children.get(pid) ?? []) total += subtreeKB(c, seen)
      return total
    }

    const now = Date.now()
    return this.sessions.map((s) => {
      const pids = pidsByName.get(s.tmuxName) ?? []
      const kb = pids.reduce((sum, pid) => sum + subtreeKB(pid), 0)
      const activity = activityByName.get(s.tmuxName)
      return {
        id: s.id,
        idleMs: activity ? Math.max(0, now - activity) : null,
        rssMB: kb > 0 ? Math.round(kb / 1024) : null
      }
    })
  }

  getStatuses(): Record<string, SessionStatus> {
    const out: Record<string, SessionStatus> = {}
    for (const [id, status] of this.lastEmittedStatus) out[id] = status
    return out
  }

  list(): SessionMeta[] {
    return [...this.sessions]
  }

  async create(opts: CreateSessionOpts): Promise<SessionMeta> {
    const id = randomUUID().slice(0, 8)
    const tmuxName = nativeTmuxName(id)
    const meta: SessionMeta = {
      id,
      name: opts.name,
      cwd: opts.cwd,
      color: opts.color ?? '#7c3aed',
      createdAt: Date.now(),
      tmuxName,
      initialCommand: opts.initialCommand
    }
    const lang = process.env.LANG || 'en_US.UTF-8'
    const lcAll = process.env.LC_ALL || lang
    await tmux(
      'new-session',
      '-d',
      '-s', tmuxName,
      '-c', opts.cwd,
      '-e', `LANG=${lang}`,
      '-e', `LC_ALL=${lcAll}`,
      '-e', `LC_CTYPE=${lcAll}`,
      '-x', '200',
      '-y', '50'
    )
    if (opts.initialCommand) {
      await tmux('send-keys', '-t', tmuxName, opts.initialCommand, 'Enter')
    }
    this.sessions.unshift(meta)
    saveSessions(this.sessions)
    return meta
  }

  async listExternal(): Promise<ExternalTmuxSession[]> {
    let raw: string
    try {
      raw = await tmux(
        'list-sessions',
        '-F',
        '#{session_name}<<EC>>#{session_windows}<<EC>>#{session_attached}<<EC>>#{session_created}'
      )
    } catch {
      return []
    }
    const importedNames = new Set(this.sessions.map((s) => s.tmuxName))
    const out: ExternalTmuxSession[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('<<EC>>')
      if (parts.length < 4) continue
      const [name, windows, attached, created] = parts
      if (!name) continue
      if (name.startsWith(NATIVE_PREFIX)) continue
      if (importedNames.has(name)) continue
      out.push({
        name,
        windows: Number(windows) || 1,
        attached: Number(attached) > 0,
        createdAt: Number(created) * 1000 || Date.now()
      })
    }
    return out
  }

  async import(opts: ImportSessionOpts): Promise<SessionMeta> {
    if (!(await tmuxSessionExistsByName(opts.tmuxName))) {
      throw new Error(`tmux session "${opts.tmuxName}" not found`)
    }
    if (this.sessions.some((s) => s.tmuxName === opts.tmuxName)) {
      throw new Error(`session "${opts.tmuxName}" is already imported`)
    }
    let cwd = ''
    try {
      cwd = (
        await tmux(
          'display-message',
          '-p',
          '-t', opts.tmuxName,
          '#{pane_current_path}'
        )
      ).trim()
    } catch {
      cwd = ''
    }
    const meta: SessionMeta = {
      id: randomUUID().slice(0, 8),
      name: opts.displayName,
      cwd,
      color: opts.color ?? '#10b981',
      createdAt: Date.now(),
      tmuxName: opts.tmuxName,
      imported: true
    }
    this.sessions.unshift(meta)
    saveSessions(this.sessions)
    return meta
  }

  private getSession(id: string): SessionMeta | undefined {
    return this.sessions.find((s) => s.id === id)
  }

  async kill(id: string): Promise<void> {
    const s = this.getSession(id)
    if (!s) return
    // If an attach/resurrect is mid-flight (user hit kill right after
    // click-attach on a dead session), wait for it — otherwise the
    // exists-check below runs before tmux finishes new-session, sees nothing,
    // skips kill-session, and the completing resurrect strands an invisible
    // orphan running the initialCommand. Draining `attaching` (which subsumes
    // resurrect) covers the window before resurrect registers its own entry.
    const inflightAttach = this.attaching.get(id)
    if (inflightAttach) await inflightAttach.catch(() => undefined)
    const inflightResurrect = this.resurrecting.get(id)
    if (inflightResurrect) await inflightResurrect.catch(() => undefined)
    await this.detach(id)
    if (!s.imported && (await tmuxSessionExistsByName(s.tmuxName))) {
      try {
        await tmux('kill-session', '-t', s.tmuxName)
      } catch {
        /* already gone */
      }
    }
    this.sessions = this.sessions.filter((x) => x.id !== id)
    saveSessions(this.sessions)
    // detach() deliberately keeps these session-scoped maps for LRU eviction;
    // here the session is truly gone, so clear them (tickAwaiting no longer
    // iterates it, so they'd otherwise linger). lastEmittedStatus is left for
    // tickStatuses to flush as a 'detached' broadcast, then drop.
    this.awaitingMap.delete(id)
    this.paneCommandMap.delete(id)
    this.lastWindowActivity.delete(id)
    this.activityChangedAt.delete(id)
  }

  async attach(id: string, cols: number, rows: number): Promise<void> {
    // In-flight guard (same pattern as `resurrecting`): the awaits between
    // the attached-check and attached.set open a window where a second
    // attach(id) — e.g. a React double-render or fast session switching —
    // passes the check too and spawns a SECOND tmux client on the same
    // session (this exact double-attach was observed live). Share one
    // in-flight attach; the trailing resize matches the latest caller.
    const inflight = this.attaching.get(id)
    if (inflight) {
      await inflight
      // If a concurrent detach (LRU eviction) won the race and tore the
      // attachment down while we were piggybacking, re-attach fresh instead of
      // resizing a dead entry — otherwise a rapid evict-then-reselect of the
      // same session could leave it detached-but-mounted (a blank pane).
      if (!this.attached.has(id)) return this.attach(id, cols, rows)
      this.resize(id, cols, rows)
      return
    }
    const job = this.doAttach(id, cols, rows).finally(() => this.attaching.delete(id))
    this.attaching.set(id, job)
    return job
  }

  private async doAttach(id: string, cols: number, rows: number): Promise<void> {
    const s = this.getSession(id)
    if (!s) throw new Error(`session ${id} not found`)
    // Anytime we successfully attach, the session is definitionally alive.
    // Flip the persisted dead flag here too — `attach()` can short-circuit
    // when already attached, so this is the single chokepoint that reliably
    // catches "previously flagged dead, but actually running" sessions.
    if (s.dead) {
      s.dead = false
      saveSessions(this.sessions)
    }
    if (this.attached.has(id)) {
      this.resize(id, cols, rows)
      return
    }
    if (!(await tmuxSessionExistsByName(s.tmuxName))) {
      await this.resurrect(s)
    }
    await this.ensureMouseAndClipboard(s.tmuxName)
    // Mark the attach-start timestamp BEFORE spawning, so the grace-window
    // check in onData sees a valid value from the very first chunk.
    this.attachedAt.set(id, Date.now())
    // Also clear the data window so any stale samples from a prior attach
    // don't get blended with the new attach's bytes.
    this.dataWindow.delete(id)
    const p = pty.spawn(
      resolveTmuxBin(),
      ['-u', 'attach-session', '-t', s.tmuxName],
      {
        name: 'xterm-256color',
        cols,
        rows,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          LANG: process.env.LANG || 'en_US.UTF-8',
          LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8'
        }
      }
    )
    p.onData((data) => {
      this.emit('data', id, data)
      // Skip the attach-time repaint burst so it isn't misread as "working".
      const attachedAt = this.attachedAt.get(id) ?? 0
      if (Date.now() - attachedAt < ATTACH_GRACE_MS) return
      let win = this.dataWindow.get(id)
      if (!win) {
        win = []
        this.dataWindow.set(id, win)
      }
      win.push({ ts: Date.now(), size: data.length })
    })
    p.onExit(() => {
      // Self-identify: only clear state if WE are still the registered pty.
      // A stale pty from a superseded attach exiting later must not wipe the
      // live attachment's bookkeeping.
      if (this.attached.get(id)?.pty !== p) return
      this.attached.delete(id)
      this.attachedAt.delete(id)
      this.dataWindow.delete(id)
      this.emit('exit', id)
    })
    this.attached.set(id, { pty: p, cols, rows })
    // Kick a redraw on EVERY attach, not only restored/resurrected sessions.
    // tmux's own attach-time repaint can land before the renderer's data
    // subscription is wired, leaving the terminal black until the next
    // output — LRU-evicted sessions re-attached on revisit hit this
    // constantly ("paints only after I press a key"). Ctrl+L makes the pane
    // app repaint once the pipeline is definitely listening.
    setTimeout(() => {
      const a = this.attached.get(id)
      if (a) {
        try {
          a.pty.write('\x0c')
        } catch {
          /* ignore */
        }
      }
    }, 300)
  }

  async detach(id: string): Promise<void> {
    // Drain an in-flight attach first (same reason as kill()): doAttach sets
    // `attached` only at its END, after several awaits. Without this, detach()
    // called during that window (e.g. a background session evicted from the
    // LRU while still attaching) would find nothing, no-op, and then the
    // completing attach spawns a pty that streams forever with no consumer —
    // the exact zombie this detach is meant to prevent.
    const inflight = this.attaching.get(id)
    if (inflight) await inflight.catch(() => undefined)
    const a = this.attached.get(id)
    if (!a) return
    // Delete BEFORE kill so the pty.onExit self-identify guard
    // (attached.get(id)?.pty !== p) is order-independent — the killed pty's
    // late exit sees it's no longer registered and stays quiet. Wrap so map
    // cleanup always runs even if kill() throws.
    this.attached.delete(id)
    this.attachedAt.delete(id)
    this.dataWindow.delete(id)
    try {
      a.pty.kill()
    } catch {
      /* pty already dead */
    }
    // NOTE: intentionally keep awaitingMap/paneCommandMap. They are
    // session-scoped (not attachment-scoped) and tickAwaiting refreshes them
    // for every alive session — so a detached-but-alive session (LRU eviction)
    // keeps accurate shell/idle/awaiting badges. kill() clears them since the
    // session is actually gone.
  }

  write(id: string, data: string): void {
    const a = this.attached.get(id)
    if (!a) return
    a.pty.write(data)
  }

  /**
   * Write raw bytes, one per code unit of `latin1Seq` (each must be 0..255).
   *
   * `write()` above hands node-pty a string, which it encodes as UTF-8. That's
   * right for typed text but WRONG for X10 mouse reports: their coordinate
   * bytes are `cell + 32`, so any column past 95 lands above 0x7F and gets
   * encoded as TWO bytes. tmux then mis-parses the report — the wheel event is
   * dropped entirely and the leftover byte is delivered to the pane as a
   * literal character (verified: column 100 typed `4`, column 150 typed `>`,
   * once per wheel notch). Buffer.from(..., 'latin1') puts exactly one byte on
   * the wire per code unit, which is the form tmux expects.
   */
  writeBinary(id: string, latin1Seq: string): void {
    const a = this.attached.get(id)
    if (!a) return
    a.pty.write(Buffer.from(latin1Seq, 'latin1'))
  }

  async sendText(id: string, text: string): Promise<void> {
    const s = this.getSession(id)
    if (!s) return
    try {
      await execFileAsync(resolveTmuxBin(), [
        '-u', 'send-keys', '-t', s.tmuxName, '-l', text
      ])
    } catch {
      /* fall back silently */
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const a = this.attached.get(id)
    if (!a) return
    if (a.cols === cols && a.rows === rows) return
    try {
      a.pty.resize(cols, rows)
      a.cols = cols
      a.rows = rows
    } catch {
      /* ignore resize on dead pty */
    }
  }

  rename(id: string, name: string): void {
    const s = this.getSession(id)
    if (!s) return
    s.name = name
    saveSessions(this.sessions)
  }

  setColor(id: string, color: string): void {
    const s = this.getSession(id)
    if (!s) return
    s.color = color
    saveSessions(this.sessions)
  }

  reorder(orderedIds: string[]): void {
    const indexOf = new Map(orderedIds.map((id, i) => [id, i]))
    this.sessions.sort((a, b) => {
      const ai = indexOf.get(a.id) ?? 9999
      const bi = indexOf.get(b.id) ?? 9999
      return ai - bi
    })
    saveSessions(this.sessions)
  }

  async dispose(): Promise<void> {
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
    if (this.awaitingTimer) {
      clearInterval(this.awaitingTimer)
      this.awaitingTimer = null
    }
    for (const id of this.attached.keys()) {
      await this.detach(id)
    }
  }
}
