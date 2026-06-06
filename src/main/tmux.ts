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
import { loadSessions, saveSessions } from './store'

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
  try {
    const out = execSync(`/bin/bash -lc 'command -v tmux'`, {
      encoding: 'utf8',
      timeout: 3000
    }).trim()
    if (out && existsSync(out)) {
      cachedTmuxBin = out
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
const AWAITING_POLL_MS = 2000

const SHELL_COMMANDS = new Set([
  'bash', 'zsh', 'fish', 'sh', 'dash', 'tcsh', 'csh', 'ksh', 'login', 'screen', 'tmux'
])

function isShellCommand(cmd: string): boolean {
  if (!cmd) return true
  const trimmed = cmd.trim().replace(/^-/, '')
  return SHELL_COMMANDS.has(trimmed)
}

function detectAwaiting(content: string): boolean {
  const lines = content.split('\n').slice(-30)
  let arrowOption = false
  let plainOption = false
  for (const line of lines) {
    if (/^\s*[❯>›]\s*\d+\.\s/.test(line)) arrowOption = true
    else if (/^\s+\d+\.\s/.test(line)) plainOption = true
  }
  return arrowOption && plainOption
}

export class TmuxManager extends EventEmitter {
  private sessions: SessionMeta[] = []
  private attached = new Map<string, AttachedPty>()
  private dataWindow = new Map<string, DataSample[]>()
  private lastEmittedStatus = new Map<string, SessionStatus>()
  private awaitingMap = new Map<string, boolean>()
  private paneCommandMap = new Map<string, string>()
  private statusTimer: NodeJS.Timeout | null = null
  private awaitingTimer: NodeJS.Timeout | null = null
  private needsRedrawOnAttach = new Set<string>()
  private resurrecting = new Map<string, Promise<void>>()
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
    try {
      await tmux(
        'bind-key', '-T', 'root', 'WheelUpPane',
        'copy-mode -e ; send-keys -X -N 3 scroll-up'
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

  async init(): Promise<void> {
    const stored = loadSessions()
    for (const s of stored) {
      s.tmuxName = s.tmuxName ?? nativeTmuxName(s.id)
      if (await tmuxSessionExistsByName(s.tmuxName)) {
        s.dead = false
        this.needsRedrawOnAttach.add(s.id)
      } else {
        // tmux server was killed (e.g. Mac reboot) — keep the metadata so the
        // user doesn't lose their project list. attach() will resurrect on demand.
        s.dead = true
      }
    }
    this.sessions = stored
    saveSessions(this.sessions)
    this.startStatusTimer()
    // Kick off an immediate probe so every restored session has a status
    // ready to display — without this the sidebar would show stale badges
    // until the first awaiting/status tick fires.
    void this.tickAwaiting().then(() => this.tickStatuses())
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
    if (s.initialCommand) {
      await tmux('send-keys', '-t', s.tmuxName, s.initialCommand, 'Enter')
    }
    s.dead = false
    this.needsRedrawOnAttach.add(s.id)
    saveSessions(this.sessions)
  }

  private startStatusTimer(): void {
    if (this.statusTimer) return
    this.statusTimer = setInterval(() => this.tickStatuses(), 400)
    this.awaitingTimer = setInterval(() => this.tickAwaiting(), AWAITING_POLL_MS)
  }

  private tickStatuses(): void {
    const now = Date.now()
    // Compute status for every alive session (not just attached). Without
    // this, the sidebar shows stale statuses on app load until the user
    // clicks each card. For non-attached sessions we don't have live data
    // flow, so 'working' can't be detected — but awaiting/shell/idle are
    // derivable from the pane command + awaiting probe alone.
    const aliveIds = new Set(this.sessions.filter((s) => !s.dead).map((s) => s.id))
    for (const id of aliveIds) {
      const isAttached = this.attached.has(id)
      const samples = this.dataWindow.get(id) ?? []
      const recent = samples.filter((s) => now - s.ts < STATUS_WINDOW_MS)
      if (recent.length !== samples.length) this.dataWindow.set(id, recent)
      const totalBytes = recent.reduce((sum, s) => sum + s.size, 0)
      const cmd = this.paneCommandMap.get(id) ?? ''
      const claudeRunning = !isShellCommand(cmd)
      let status: SessionStatus
      if (this.awaitingMap.get(id)) status = 'awaiting'
      else if (!claudeRunning) status = 'shell'
      else if (isAttached && totalBytes > STATUS_BYTE_THRESHOLD) status = 'working'
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
    await Promise.all(
      alive.map(async (s) => {
        try {
          const content = await this.capturePaneText(s.tmuxName, 30)
          this.awaitingMap.set(s.id, detectAwaiting(content))
        } catch {
          /* capture failed; leave previous value */
        }
        try {
          const { stdout } = await execFileAsync(resolveTmuxBin(), [
            '-u', 'display-message', '-p', '-t', s.tmuxName, '#{pane_current_command}'
          ])
          this.paneCommandMap.set(s.id, stdout.trim())
        } catch {
          /* leave previous value */
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
  }

  async attach(id: string, cols: number, rows: number): Promise<void> {
    if (this.attached.has(id)) {
      this.resize(id, cols, rows)
      return
    }
    const s = this.getSession(id)
    if (!s) throw new Error(`session ${id} not found`)
    if (!(await tmuxSessionExistsByName(s.tmuxName))) {
      await this.resurrect(s)
    }
    await this.ensureMouseAndClipboard(s.tmuxName)
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
      let win = this.dataWindow.get(id)
      if (!win) {
        win = []
        this.dataWindow.set(id, win)
      }
      win.push({ ts: Date.now(), size: data.length })
    })
    p.onExit(() => {
      this.attached.delete(id)
      this.dataWindow.delete(id)
      this.emit('exit', id)
    })
    this.attached.set(id, { pty: p, cols, rows })
    if (this.needsRedrawOnAttach.has(id)) {
      this.needsRedrawOnAttach.delete(id)
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
  }

  async detach(id: string): Promise<void> {
    const a = this.attached.get(id)
    if (!a) return
    a.pty.kill()
    this.attached.delete(id)
    this.dataWindow.delete(id)
    this.awaitingMap.delete(id)
    this.paneCommandMap.delete(id)
  }

  write(id: string, data: string): void {
    const a = this.attached.get(id)
    if (!a) return
    a.pty.write(data)
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
