import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { EventEmitter } from 'node:events'
import { app } from 'electron'
import type {
  SessionMeta,
  CreateSessionOpts,
  ExternalTmuxSession,
  ImportSessionOpts,
  SessionStatus
} from '../types'
import { loadSessions, saveSessions } from '../store'

/**
 * ZellijManager — Windows-native backend for session management.
 *
 * Mirrors the public API of TmuxManager so src/main/index.ts can substitute
 * one for the other based on process.platform. The TmuxManager is left
 * untouched; this file is the only thing Windows builds need to differ on.
 *
 * Status: MVP. The status detection still uses the same polling loop the
 * tmux backend uses (capture-pane every 2s) rather than the better
 * `zellij subscribe` event stream — that's a follow-up optimization once
 * the basic flow is proven end-to-end.
 */

const execFileAsync = promisify(execFile)

/**
 * Path to the zellij binary. In packaged builds we bundle zellij.exe under
 * the app's resources directory (configured via build.win.extraResources in
 * package.json). In dev mode (`npm run dev`) the binary isn't bundled, so
 * fall back to the build/win/ copy in the source tree, then finally to PATH
 * (so the spike workflow on Mac still works).
 *
 * Override at runtime with the ZELLIJ_BIN environment variable.
 */
function resolveZellijBin(): string {
  if (process.env.ZELLIJ_BIN) return process.env.ZELLIJ_BIN
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'zellij.exe')
    if (existsSync(bundled)) return bundled
  }
  // Dev mode — look for the binary inside the source tree
  const devBundled = join(app.getAppPath(), 'build', 'win', 'zellij.exe')
  if (existsSync(devBundled)) return devBundled
  return 'zellij'
}

const ZELLIJ_BIN_LAZY: { value: string | null } = { value: null }
function ZELLIJ_BIN(): string {
  if (!ZELLIJ_BIN_LAZY.value) ZELLIJ_BIN_LAZY.value = resolveZellijBin()
  return ZELLIJ_BIN_LAZY.value
}

const NATIVE_PREFIX = 'pikudclaude-'
const nativeZellijName = (id: string): string => `${NATIVE_PREFIX}${id}`

async function zellij(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(ZELLIJ_BIN(), args)
  return stdout
}

async function zellijSessionExists(name: string): Promise<boolean> {
  try {
    const out = await zellij('list-sessions')
    // list-sessions returns colored text lines like "spike-test [Created 1s ago]"
    // — we match the session name at line start, after stripping ANSI.
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '')
    return plain.split(/\r?\n/).some((line) => line.trimStart().startsWith(name + ' ') || line.trimStart() === name)
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

interface ZellijPane {
  id: number
  is_plugin: boolean
  exited: boolean
  terminal_command: string | null
  title: string
  tab_id: number
}

const STATUS_WINDOW_MS = 1500
const STATUS_BYTE_THRESHOLD = 200
// See tmux.ts for the same constant — drop the bytes from the attach-time
// repaint so it isn't misread as "working" the moment a session is opened.
const ATTACH_GRACE_MS = 2500
const AWAITING_POLL_MS = 2000

const SHELL_COMMANDS = new Set([
  'bash', 'zsh', 'fish', 'sh', 'dash', 'tcsh', 'csh', 'ksh', 'login',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'
])

function isShellCommand(cmd: string): boolean {
  if (!cmd) return true
  const trimmed = cmd.trim().toLowerCase()
  // Zellij stores commands like "/bin/sh -c ..." or "pwsh.exe -NoLogo". Take
  // the first token, strip directory + leading dash (login shells).
  const first = trimmed.split(/\s+/)[0].replace(/^.*[\\/]/, '').replace(/^-/, '')
  return SHELL_COMMANDS.has(first)
}

function detectAwaiting(content: string): boolean {
  // Same heuristic as the tmux backend: Claude Code's numbered-options prompt
  // shows a highlighted "❯ N." current option plus other plain "  N." rows.
  const lines = content.split('\n').slice(-30)
  let arrowOption = false
  let plainOption = false
  for (const line of lines) {
    if (/^\s*[❯>›]\s*\d+\.\s/.test(line)) arrowOption = true
    else if (/^\s+\d+\.\s/.test(line)) plainOption = true
  }
  return arrowOption && plainOption
}

/**
 * Per-session runtime state we can't put on SessionMeta (those serialize to
 * disk). Zellij assigns numeric pane ids that change across resurrects; we
 * cache the current one to avoid an extra list-panes call on every action.
 */
interface RuntimeState {
  paneId: number | null
}

export class ZellijManager extends EventEmitter {
  private sessions: SessionMeta[] = []
  private runtime = new Map<string, RuntimeState>()
  private attached = new Map<string, AttachedPty>()
  private attachedAt = new Map<string, number>()
  private dataWindow = new Map<string, DataSample[]>()
  private lastEmittedStatus = new Map<string, SessionStatus>()
  private awaitingMap = new Map<string, boolean>()
  private paneCommandMap = new Map<string, string>()
  private statusTimer: NodeJS.Timeout | null = null
  private awaitingTimer: NodeJS.Timeout | null = null
  private needsRedrawOnAttach = new Set<string>()
  private resurrecting = new Map<string, Promise<void>>()

  async init(): Promise<void> {
    const stored = loadSessions()
    for (const s of stored) {
      s.tmuxName = s.tmuxName ?? nativeZellijName(s.id)
      this.runtime.set(s.id, { paneId: null })
      if (await zellijSessionExists(s.tmuxName)) {
        s.dead = false
        this.needsRedrawOnAttach.add(s.id)
        await this.refreshPaneId(s)
      } else {
        s.dead = true
      }
    }
    this.sessions = stored
    saveSessions(this.sessions)
    this.startStatusTimer()
  }

  /** Re-query the session for its (probably one) terminal pane and cache its id. */
  private async refreshPaneId(s: SessionMeta): Promise<void> {
    try {
      const out = await zellij('--session', s.tmuxName, 'action', 'list-panes', '--json')
      const panes: ZellijPane[] = JSON.parse(out)
      const terminal = panes.find((p) => !p.is_plugin && !p.exited)
      if (terminal) {
        const r = this.runtime.get(s.id) ?? { paneId: null }
        r.paneId = terminal.id
        this.runtime.set(s.id, r)
      }
    } catch {
      /* list-panes can briefly fail right after session create; the next status
         tick will retry */
    }
  }

  private async resurrect(s: SessionMeta): Promise<void> {
    const inflight = this.resurrecting.get(s.id)
    if (inflight) return inflight
    const job = this.spawnFreshZellij(s).finally(() => this.resurrecting.delete(s.id))
    this.resurrecting.set(s.id, job)
    return job
  }

  private async spawnFreshZellij(s: SessionMeta): Promise<void> {
    if (s.imported) {
      throw new Error(
        `Imported session "${s.name}" can't be auto-resurrected — re-import it from an existing zellij session.`
      )
    }
    const cwd = s.cwd && existsSync(s.cwd) ? s.cwd : homedir()

    // Step 1 — create the session in the background. Zellij's --default-cwd
    // doesn't propagate to action new-pane, so we'll re-specify cwd below.
    await zellij('attach', '--create-background', s.tmuxName)

    // Step 2 — spawn our actual pane. Stdout returns "terminal_N\n".
    const cmd = s.initialCommand || (process.env.SHELL || 'cmd.exe')
    const newPaneOut = await zellij(
      '--session', s.tmuxName,
      'action', 'new-pane',
      '--cwd', cwd,
      '--',
      ...cmd.split(/\s+/)
    )
    const m = /terminal_(\d+)/.exec(newPaneOut.trim())
    if (m) {
      const r = this.runtime.get(s.id) ?? { paneId: null }
      r.paneId = Number(m[1])
      this.runtime.set(s.id, r)
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
    const seen = new Set<string>()
    for (const id of this.attached.keys()) {
      seen.add(id)
      const samples = this.dataWindow.get(id) ?? []
      const recent = samples.filter((s) => now - s.ts < STATUS_WINDOW_MS)
      if (recent.length !== samples.length) this.dataWindow.set(id, recent)
      const totalBytes = recent.reduce((sum, s) => sum + s.size, 0)
      const cmd = this.paneCommandMap.get(id) ?? ''
      const claudeRunning = !isShellCommand(cmd)
      let status: SessionStatus
      if (this.awaitingMap.get(id)) status = 'awaiting'
      else if (!claudeRunning) status = 'shell'
      else if (totalBytes > STATUS_BYTE_THRESHOLD) status = 'working'
      else status = 'idle'
      if (this.lastEmittedStatus.get(id) !== status) {
        this.lastEmittedStatus.set(id, status)
        this.emit('status', id, status)
      }
    }
    for (const id of this.lastEmittedStatus.keys()) {
      if (!seen.has(id)) {
        this.lastEmittedStatus.set(id, 'detached')
        this.emit('status', id, 'detached')
        this.lastEmittedStatus.delete(id)
      }
    }
  }

  private async tickAwaiting(): Promise<void> {
    for (const id of this.attached.keys()) {
      const s = this.getSession(id)
      if (!s) continue
      const r = this.runtime.get(id)
      if (!r?.paneId) {
        await this.refreshPaneId(s)
        continue
      }
      try {
        const content = await this.dumpScreen(s.tmuxName, r.paneId, 30)
        this.awaitingMap.set(id, detectAwaiting(content))
      } catch {
        /* leave previous value */
      }
      try {
        const out = await zellij('--session', s.tmuxName, 'action', 'list-panes', '--json')
        const panes: ZellijPane[] = JSON.parse(out)
        const pane = panes.find((p) => p.id === r.paneId)
        this.paneCommandMap.set(id, pane?.terminal_command ?? '')
      } catch {
        /* leave previous value */
      }
    }
  }

  /**
   * Write the pane's current screen + N lines of scrollback to a temp file
   * (zellij's dump-screen has no stdout mode) and read it back.
   */
  private async dumpScreen(sessionName: string, paneId: number, lines: number): Promise<string> {
    void lines // zellij dumps full visible viewport; line trimming happens caller-side
    const dir = mkdtempSync(join(tmpdir(), 'pikud-dump-'))
    const path = join(dir, 'screen.txt')
    try {
      await zellij(
        '--session', sessionName,
        'action', 'dump-screen',
        '--pane-id', String(paneId),
        '--ansi',
        '--path', path
      )
      return readFileSync(path, 'utf8')
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  async captureSnapshot(id: string, lines = 50): Promise<string> {
    const s = this.getSession(id)
    if (!s) throw new Error(`session ${id} not found`)
    const r = this.runtime.get(id)
    if (!r?.paneId) return ''
    return this.dumpScreen(s.tmuxName, r.paneId, lines)
  }

  async captureLive(id: string): Promise<string> {
    const s = this.getSession(id)
    if (!s) return ''
    const r = this.runtime.get(id)
    if (!r?.paneId) return ''
    try {
      return await this.dumpScreen(s.tmuxName, r.paneId, 50)
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
    const zellijName = nativeZellijName(id)
    const meta: SessionMeta = {
      id,
      name: opts.name,
      cwd: opts.cwd,
      color: opts.color ?? '#7c3aed',
      createdAt: Date.now(),
      tmuxName: zellijName,
      initialCommand: opts.initialCommand
    }
    this.runtime.set(id, { paneId: null })
    this.sessions.unshift(meta)
    await this.spawnFreshZellij(meta) // also saves
    return meta
  }

  /**
   * On Windows there is no analogue to "external tmux sessions a user is
   * already running" — Zellij isn't a fixture of the system shell, it's our
   * runtime. Return empty; the UI's "Import existing" path will look empty
   * but not error out.
   */
  async listExternal(): Promise<ExternalTmuxSession[]> {
    try {
      const out = await zellij('list-sessions')
      const plain = out.replace(/\x1b\[[0-9;]*m/g, '')
      const importedNames = new Set(this.sessions.map((s) => s.tmuxName))
      const result: ExternalTmuxSession[] = []
      for (const line of plain.split(/\r?\n/)) {
        const m = /^(\S+)\s+\[Created\s+(.+?)\s+ago\]/.exec(line.trim())
        if (!m) continue
        const name = m[1]
        if (name.startsWith(NATIVE_PREFIX) || importedNames.has(name)) continue
        result.push({
          name,
          windows: 1,
          attached: line.includes('EXITED') ? false : true,
          createdAt: Date.now() // Zellij doesn't expose creation timestamp via CLI; approximate
        })
      }
      return result
    } catch {
      return []
    }
  }

  async import(opts: ImportSessionOpts): Promise<SessionMeta> {
    if (!(await zellijSessionExists(opts.tmuxName))) {
      throw new Error(`zellij session "${opts.tmuxName}" not found`)
    }
    if (this.sessions.some((s) => s.tmuxName === opts.tmuxName)) {
      throw new Error(`session "${opts.tmuxName}" is already imported`)
    }
    const meta: SessionMeta = {
      id: randomUUID().slice(0, 8),
      name: opts.displayName,
      cwd: '', // Zellij doesn't expose per-pane cwd through the CLI we use today
      color: opts.color ?? '#10b981',
      createdAt: Date.now(),
      tmuxName: opts.tmuxName,
      imported: true
    }
    this.runtime.set(meta.id, { paneId: null })
    await this.refreshPaneId(meta)
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
    if (!s.imported && (await zellijSessionExists(s.tmuxName))) {
      try {
        await zellij('kill-session', s.tmuxName)
      } catch {
        /* already gone */
      }
    }
    this.sessions = this.sessions.filter((x) => x.id !== id)
    this.runtime.delete(id)
    saveSessions(this.sessions)
  }

  async attach(id: string, cols: number, rows: number): Promise<void> {
    if (this.attached.has(id)) {
      this.resize(id, cols, rows)
      return
    }
    const s = this.getSession(id)
    if (!s) throw new Error(`session ${id} not found`)
    if (!(await zellijSessionExists(s.tmuxName))) {
      await this.resurrect(s)
    } else if (!this.runtime.get(id)?.paneId) {
      await this.refreshPaneId(s)
    }
    this.attachedAt.set(id, Date.now())
    this.dataWindow.delete(id)
    const p = pty.spawn(
      ZELLIJ_BIN(),
      ['attach', s.tmuxName],
      {
        name: 'xterm-256color',
        cols,
        rows,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        }
      }
    )
    p.onData((data) => {
      this.emit('data', id, data)
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
      this.attached.delete(id)
      this.attachedAt.delete(id)
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
    this.attachedAt.delete(id)
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
    // zellij action send-keys only accepts named keys (e.g. "Enter", "Ctrl c"),
    // not raw text. For arbitrary text we write through the attached pty,
    // which is what user typing already does. Programmatic "paste" callers
    // can use this method; we just route it through the pty too.
    const a = this.attached.get(id)
    if (!a) return
    a.pty.write(text)
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
