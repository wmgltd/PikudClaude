import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Settings } from '../shared/settings'
import type { ActiveUsageBlock } from '../shared/usage'
import type { SessionVitals } from '../shared/vitals'
import type { ScreenCheckResult } from '../shared/screenSync'
import type { IpcRendererEvent } from 'electron'

interface SessionMeta {
  id: string
  name: string
  cwd: string
  color: string
  createdAt: number
  tmuxName: string
  imported?: boolean
}

interface CreateSessionOpts {
  name: string
  cwd: string
  color?: string
  initialCommand?: string
}

interface ExternalTmuxSession {
  name: string
  windows: number
  attached: boolean
  createdAt: number
}

interface ImportSessionOpts {
  tmuxName: string
  displayName: string
  color?: string
}

type SessionStatus = 'working' | 'idle' | 'awaiting' | 'detached'

interface Bookmark {
  id: string
  sessionId: string
  label: string
  createdAt: number
  snapshot: string
}

interface ProjectInfo {
  name: string
  path: string
  kind: string
}


interface MemoryPressure {
  swapUsedMB: number
  swapTotalMB: number
  ramTotalMB: number
  critical: boolean
}


const api = {
  listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke('tmux:list'),
  createSession: (opts: CreateSessionOpts): Promise<SessionMeta> =>
    ipcRenderer.invoke('tmux:create', opts),
  listExternalTmux: (): Promise<ExternalTmuxSession[]> =>
    ipcRenderer.invoke('tmux:list-external'),
  importSession: (opts: ImportSessionOpts): Promise<SessionMeta> =>
    ipcRenderer.invoke('tmux:import', opts),
  killSession: (id: string): Promise<void> => ipcRenderer.invoke('tmux:kill', id),
  attachSession: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('tmux:attach', id, cols, rows),
  detachSession: (id: string): Promise<void> => ipcRenderer.invoke('tmux:detach', id),
  writeSession: (id: string, data: string): Promise<void> =>
    ipcRenderer.invoke('tmux:write', id, data),
  // Every code unit of `data` must be 0..255 and is written as one raw byte.
  // Used for X10 mouse reports, which break if UTF-8 encoded.
  writeSessionBytes: (id: string, data: string): Promise<void> =>
    ipcRenderer.invoke('tmux:write-binary', id, data),
  // Screen-sync sample for the visible terminal: xterm's non-empty row
  // count plus DOM-side context; main compares against the tmux pane and
  // forces a redraw when they disagree. See TmuxManager.screenCheck.
  screenCheck: (
    id: string,
    xtermNonEmpty: number,
    context: Record<string, unknown>
  ): Promise<ScreenCheckResult | null> =>
    ipcRenderer.invoke('tmux:screen-check', id, xtermNonEmpty, context),
  isInCopyMode: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('tmux:in-copy-mode', id),
  sendText: (id: string, text: string): Promise<void> =>
    ipcRenderer.invoke('tmux:send-text', id, text),
  resizeSession: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('tmux:resize', id, cols, rows),
  renameSession: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke('tmux:rename', id, name),
  setSessionColor: (id: string, color: string): Promise<void> =>
    ipcRenderer.invoke('tmux:set-color', id, color),
  reorderSessions: (orderedIds: string[]): Promise<void> =>
    ipcRenderer.invoke('tmux:reorder', orderedIds),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-directory'),

  onSessionData: (handler: (id: string, data: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, data: string) => handler(id, data)
    ipcRenderer.on('tmux:data', listener)
    return () => ipcRenderer.removeListener('tmux:data', listener)
  },
  onSessionExit: (handler: (id: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string) => handler(id)
    ipcRenderer.on('tmux:exit', listener)
    return () => ipcRenderer.removeListener('tmux:exit', listener)
  },
  getStatuses: (): Promise<Record<string, SessionStatus>> =>
    ipcRenderer.invoke('tmux:get-statuses'),
  getSessionVitals: (): Promise<SessionVitals[]> => ipcRenderer.invoke('tmux:get-vitals'),
  captureLive: (id: string): Promise<string> => ipcRenderer.invoke('tmux:capture-live', id),
  captureScrollback: (id: string): Promise<string> =>
    ipcRenderer.invoke('tmux:capture-scrollback', id),
  loadPromptHistory: (): Promise<Record<string, Array<{ text: string; ts: number }>>> =>
    ipcRenderer.invoke('prompts:load'),
  savePromptHistory: (
    history: Record<string, Array<{ text: string; ts: number }>>
  ): Promise<void> => ipcRenderer.invoke('prompts:save', history),
  loadPromptStats: (): Promise<Record<string, number[]>> =>
    ipcRenderer.invoke('promptStats:load'),
  savePromptStats: (stats: Record<string, number[]>): Promise<void> =>
    ipcRenderer.invoke('promptStats:save', stats),
  watchConversation: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('conversation:watch', sessionId),
  unwatchConversation: (): Promise<void> => ipcRenderer.invoke('conversation:unwatch'),
  onConversationEvent: (
    handler: (
      event:
        | {
            type: 'initial' | 'append'
            messages: Array<{
              id: string
              role: 'user' | 'assistant' | 'tool_use' | 'tool_result'
              text: string
              ts: number
              toolName?: string
            }>
            // 'initial' only: the transcript was longer than what we loaded.
            truncated?: boolean
          }
        | { type: 'reset' }
        | { type: 'sync_complete' }
    ) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, evt: Parameters<typeof handler>[0]): void =>
      handler(evt)
    ipcRenderer.on('conversation:event', listener)
    return () => ipcRenderer.removeListener('conversation:event', listener)
  },
  onSessionStatus: (handler: (id: string, status: SessionStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, status: SessionStatus) =>
      handler(id, status)
    ipcRenderer.on('tmux:status', listener)
    return () => ipcRenderer.removeListener('tmux:status', listener)
  },

  listBookmarks: (sessionId: string): Promise<Bookmark[]> =>
    ipcRenderer.invoke('bookmarks:list', sessionId),
  createBookmark: (sessionId: string, label: string): Promise<Bookmark> =>
    ipcRenderer.invoke('bookmarks:create', sessionId, label),
  deleteBookmark: (id: string): Promise<void> =>
    ipcRenderer.invoke('bookmarks:delete', id),

  scanProjects: (): Promise<ProjectInfo[]> => ipcRenderer.invoke('projects:scan'),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (next: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:save', next),

  getActiveBlock: (): Promise<ActiveUsageBlock | null> =>
    ipcRenderer.invoke('usage:get-active-block'),

  getMemoryPressure: (): Promise<MemoryPressure | null> =>
    ipcRenderer.invoke('system:get-memory-pressure'),
  onMemoryPressure: (handler: (p: MemoryPressure) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: MemoryPressure): void => handler(p)
    ipcRenderer.on('system:memory-pressure', listener)
    return () => ipcRenderer.removeListener('system:memory-pressure', listener)
  },

  checkForUpdatesNow: (): Promise<{
    ok: boolean
    hasUpdate?: boolean
    version?: string | null
    reason?: string
  }> => ipcRenderer.invoke('updates:check-now'),
  setUpdateChannel: (channel: 'stable' | 'beta'): Promise<void> =>
    ipcRenderer.invoke('updates:set-channel', channel),
  onUpdateStatus: (handler: (status: string, payload?: unknown) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, msg: { status: string; payload?: unknown }) =>
      handler(msg.status, msg.payload)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },

  getGitBranch: (cwd: string): Promise<string | null> =>
    ipcRenderer.invoke('git:get-branch', cwd),

  writeClipboard: (text: string): Promise<void> =>
    ipcRenderer.invoke('app:clipboard-write', text),

  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:open-external', url),
  openFile: (opts: { path: string; line?: number; col?: number; cwd?: string; ide?: string }): Promise<void> =>
    ipcRenderer.invoke('app:open-file', opts),

  notifyAwaiting: (sessionId: string, sessionName: string): Promise<void> =>
    ipcRenderer.invoke('notify:awaiting', sessionId, sessionName),
  onNotificationClick: (handler: (sessionId: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sessionId: string) => handler(sessionId)
    ipcRenderer.on('notification:click', listener)
    return () => ipcRenderer.removeListener('notification:click', listener)
  },
  onMenuAction: (handler: (action: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, action: string) => handler(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  },

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  attachImage: (path: string): Promise<void> =>
    ipcRenderer.invoke('drag:attach-image', path),

  logRendererError: (entry: { kind: string; message: string; stack?: string; context?: Record<string, unknown> }): Promise<void> =>
    ipcRenderer.invoke('errors:log-renderer', entry),
  revealErrorLog: (): Promise<void> => ipcRenderer.invoke('errors:reveal-log'),

  installUpdateNow: (): Promise<void> => ipcRenderer.invoke('updates:install-now'),

  getStatsSummary: (
    rangeDays: number
  ): Promise<{
    rangeDays: number
    startTs: number
    endTs: number
    totalPrompts: number
    totalActiveMs: number
    totalBookmarks: number
    projectsTouched: number
    hebrewPercent: number
    projects: Array<{
      cwd: string
      name: string
      prompts: number
      activeMs: number
      bookmarks: number
      sessions: number
      lastSeen: number
    }>
    byDay: Array<{ date: string; prompts: number; activeMs: number }>
    prev: {
      prompts: number
      activeMs: number
      bookmarks: number
      projectsTouched: number
    }
  }> => ipcRenderer.invoke('stats:get-summary', rangeDays),
  getStatsHeatmap: (
    rangeDays: number
  ): Promise<{ cells: number[][]; max: number; rangeDays: number }> =>
    ipcRenderer.invoke('stats:get-heatmap', rangeDays),
  getProjectDetail: (
    cwd: string,
    rangeDays: number
  ): Promise<{
    cwd: string
    name: string
    rangeDays: number
    totalPrompts: number
    totalActiveMs: number
    bookmarks: number
    sessions: number
    hebrewPercent: number
    firstSeen: number
    lastSeen: number
    byDay: Array<{ date: string; prompts: number; activeMs: number }>
    byHour: number[]
    prev: { prompts: number; activeMs: number; bookmarks: number }
  } | null> => ipcRenderer.invoke('stats:get-project-detail', cwd, rangeDays),
  recordPrompt: (sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('stats:record-prompt', sessionId, text),
  onAppResumed: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('app:resumed', listener)
    return () => ipcRenderer.removeListener('app:resumed', listener)
  },

  getTelemetryStatus: (): Promise<{
    enabled: boolean
    consentShownAt: number
    lastHeartbeatAt: number
    anonId: string
  }> => ipcRenderer.invoke('telemetry:get-status'),
  setTelemetryEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('telemetry:set-enabled', enabled),
  markTelemetryConsentShown: (): Promise<void> =>
    ipcRenderer.invoke('telemetry:mark-consent-shown'),
  previewTelemetryPayload: (): Promise<unknown> =>
    ipcRenderer.invoke('telemetry:preview-payload'),
  resetTelemetryAnonId: (): Promise<string> => ipcRenderer.invoke('telemetry:reset-anon-id'),
  markTelemetryFeature: (
    feature:
      | 'ide_jump'
      | 'palette'
      | 'conversation_panel'
      | 'stats_view'
      | 'search'
      | 'scrollback_overlay'
  ): Promise<void> => ipcRenderer.invoke('telemetry:mark-feature', feature)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
