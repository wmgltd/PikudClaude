import { contextBridge, ipcRenderer, webUtils } from 'electron'
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

type ThemeName = 'default' | 'solarized-dark' | 'dracula' | 'nord' | 'light' | 'custom'
type CursorStyle = 'block' | 'underline' | 'bar'
type SoundType = 'chime' | 'beep'

interface Settings {
  notifications: {
    soundEnabled: boolean
    soundType: SoundType
    volume: number
    systemNotifications: boolean
    onlyWhenUnfocused: boolean
    quietHoursEnabled: boolean
    quietHoursStart: string
    quietHoursEnd: string
  }
  sessions: {
    defaultInitialCommand: string
    defaultCwd: string
    defaultColor: string
    autoBookmarkOnAwaiting: boolean
    recentProjectsMax: number
    preferredIDE: 'cursor' | 'vscode' | 'finder'
  }
  appearance: {
    fontSize: number
    fontFamily: string
    lineHeight: number
    cursorStyle: CursorStyle
    cursorBlink: boolean
    theme: ThemeName
    customTheme: {
      background: string
      foreground: string
      cursor: string
      selectionBackground: string
    }
  }
  ui: {
    welcomeShown: boolean
  }
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
  captureLive: (id: string): Promise<string> => ipcRenderer.invoke('tmux:capture-live', id),
  captureScrollback: (id: string): Promise<string> =>
    ipcRenderer.invoke('tmux:capture-scrollback', id),
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

  getActiveBlock: (): Promise<{
    startTime: string
    endTime: string
    totalTokens: number
    costUSD: number
    msUntilReset: number
    percentUsed: number | null
  } | null> => ipcRenderer.invoke('usage:get-active-block'),

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

  logRendererError: (entry: { kind: string; message: string; stack?: string; context?: Record<string, unknown> }): Promise<void> =>
    ipcRenderer.invoke('errors:log-renderer', entry),
  revealErrorLog: (): Promise<void> => ipcRenderer.invoke('errors:reveal-log'),

  installUpdateNow: (): Promise<void> => ipcRenderer.invoke('updates:install-now')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
