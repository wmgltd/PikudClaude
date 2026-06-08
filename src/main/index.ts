import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, Notification, Menu, clipboard, powerMonitor } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { TmuxManager } from './tmux'
import { ZellijManager } from './win32/zellijManager'
import { BookmarkStore } from './bookmarks'
import { scanProjects } from './projects'
import { SettingsStore, type Settings } from './settings'
import { getActiveBlock } from './usage'
import { initErrorLogging, appendErrorEntry, revealErrorLog } from './errorLog'
import {
  loadPromptHistory,
  savePromptHistory,
  loadPromptStats,
  savePromptStats
} from './store'
import { watchConversation } from './conversation'
import {
  recordPromptSent,
  recordStatusChange,
  recordSessionCreated,
  recordSessionClosed,
  recordBookmarkCreated,
  getSummary,
  getHeatmap,
  getProjectDetail
} from './stats'
import type { CreateSessionOpts, ImportSessionOpts } from './types'

const isDev = !app.isPackaged

app.setName('PikudClaude')
app.setPath('userData', join(app.getPath('appData'), 'pikudclaude'))

// Wire crash dumps + uncaught-error capture as early as possible so we catch
// init-time crashes too.
initErrorLogging()

const ICON_PATH = isDev
  ? join(__dirname, '../../build/icon.png')
  : join(process.resourcesPath, 'icon.png')

if (process.platform === 'darwin' && isDev && existsSync(ICON_PATH)) {
  try {
    app.dock?.setIcon(nativeImage.createFromPath(ICON_PATH))
  } catch {
    /* dock icon set may fail before app ready; retry inside whenReady */
  }
}

let mainWindow: BrowserWindow | null = null
let rendererReady = false
// On Windows, the tmux binary doesn't exist natively. ZellijManager
// implements the same public API but drives `zellij` (a Rust-based
// multiplexer with native Windows support) instead. Mac and Linux keep
// using tmux exactly as before.
const manager = process.platform === 'win32'
  ? new ZellijManager()
  : new TmuxManager()
const bookmarks = new BookmarkStore()
const settings = new SettingsStore()

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0b10',
    show: false,
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    title: 'PikudClaude',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })

  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false
  })
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function wireIpc(): void {
  // Look up the cwd for a session id from the manager's current list. Returns
  // empty string if not found — stats helpers no-op on missing cwd.
  const cwdOf = (id: string): string => {
    const s = manager.list().find((x) => x.id === id)
    return s?.cwd ?? ''
  }

  ipcMain.handle('tmux:list', () => manager.list())

  ipcMain.handle('tmux:create', async (_e, opts: CreateSessionOpts) => {
    const meta = await manager.create(opts)
    recordSessionCreated(meta.id, meta.cwd, meta.name)
    return meta
  })

  ipcMain.handle('tmux:list-external', () => manager.listExternal())

  ipcMain.handle('tmux:import', async (_e, opts: ImportSessionOpts) => {
    return manager.import(opts)
  })

  ipcMain.handle('tmux:kill', async (_e, id: string) => {
    const cwd = cwdOf(id)
    await manager.kill(id)
    bookmarks.removeAllForSession(id)
    if (cwd) recordSessionClosed(id, cwd)
  })

  ipcMain.handle('tmux:attach', async (_e, id: string, cols: number, rows: number) => {
    await manager.attach(id, cols, rows)
  })

  ipcMain.handle('tmux:detach', async (_e, id: string) => {
    await manager.detach(id)
  })

  ipcMain.handle('tmux:write', (_e, id: string, data: string) => {
    manager.write(id, data)
  })

  ipcMain.handle('tmux:send-text', async (_e, id: string, text: string) => {
    await manager.sendText(id, text)
    recordPromptSent(id, cwdOf(id), text)
  })

  ipcMain.handle('tmux:resize', (_e, id: string, cols: number, rows: number) => {
    manager.resize(id, cols, rows)
  })

  ipcMain.handle('tmux:rename', (_e, id: string, name: string) => {
    manager.rename(id, name)
  })

  ipcMain.handle('tmux:set-color', (_e, id: string, color: string) => {
    manager.setColor(id, color)
  })

  ipcMain.handle('tmux:reorder', (_e, orderedIds: string[]) => {
    manager.reorder(orderedIds)
  })

  ipcMain.handle('tmux:get-statuses', () => manager.getStatuses())

  ipcMain.handle('tmux:capture-live', (_e, id: string) => manager.captureLive(id))

  ipcMain.handle('tmux:capture-scrollback', (_e, id: string) =>
    manager.captureSnapshot(id, 10000)
  )

  // Drag-dropped image files: write the file's bytes to the system
  // clipboard as image data so Claude Code's paste-image flow can pick it
  // up. The renderer follows up by sending a bracketed paste sequence to
  // nudge Claude into checking the clipboard.
  ipcMain.handle('drag:attach-image', async (_e, filePath: string) => {
    const img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) throw new Error('not a valid image file')
    clipboard.writeImage(img)
  })

  ipcMain.handle('prompts:load', () => loadPromptHistory())
  ipcMain.handle(
    'prompts:save',
    (_e, history: Record<string, Array<{ text: string; ts: number }>>) => {
      savePromptHistory(history)
    }
  )
  ipcMain.handle('promptStats:load', () => loadPromptStats())
  ipcMain.handle('promptStats:save', (_e, stats: Record<string, number[]>) => {
    savePromptStats(stats)
  })

  // Conversation panel: tail Claude's jsonl session log and stream incremental
  // events (initial backlog → append/reset). Only one watcher at a time (the
  // currently-open panel).
  let convWatcher: (() => void) | null = null
  ipcMain.handle('conversation:watch', (_e, cwd: string) => {
    convWatcher?.()
    const win = BrowserWindow.getAllWindows()[0]
    convWatcher = watchConversation(cwd, (evt) => {
      win?.webContents.send('conversation:event', evt)
    })
  })
  ipcMain.handle('conversation:unwatch', () => {
    convWatcher?.()
    convWatcher = null
  })

  // Stats dashboard: read aggregated metrics from the event log.
  ipcMain.handle('stats:get-summary', (_e, rangeDays: number) => getSummary(rangeDays))
  ipcMain.handle('stats:get-heatmap', (_e, rangeDays: number) => getHeatmap(rangeDays))
  ipcMain.handle('stats:get-project-detail', (_e, cwd: string, rangeDays: number) =>
    getProjectDetail(cwd, rangeDays)
  )
  // Prompts are sent via raw writeSession keystrokes (not tmux:send-text), so
  // the renderer's onPromptSubmit callback is the only reliable signal that
  // a prompt was submitted. It calls this IPC after each submission.
  ipcMain.handle('stats:record-prompt', (_e, sessionId: string, text: string) => {
    recordPromptSent(sessionId, cwdOf(sessionId), text)
  })

  ipcMain.handle('dialog:pick-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('home')
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('bookmarks:list', (_e, sessionId: string) => bookmarks.list(sessionId))

  ipcMain.handle(
    'bookmarks:create',
    async (_e, sessionId: string, label: string) => {
      let snapshot = ''
      try {
        snapshot = await manager.captureSnapshot(sessionId, 60)
      } catch {
        snapshot = ''
      }
      const bm = bookmarks.create(sessionId, label, snapshot)
      recordBookmarkCreated(sessionId, cwdOf(sessionId))
      return bm
    }
  )

  ipcMain.handle('bookmarks:delete', (_e, id: string) => {
    bookmarks.remove(id)
  })

  ipcMain.handle('projects:scan', () => {
    const root = settings.get().sessions.projectsRoot
    return scanProjects(root ? [root] : undefined)
  })

  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:save', (_e, next: Partial<Settings>) => settings.save(next))

  ipcMain.handle('usage:get-active-block', () => getActiveBlock())

  ipcMain.handle('git:get-branch', async (_e, cwd: string) => {
    if (!cwd) return null
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/git',
        ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { timeout: 3000 }
      )
      const name = stdout.trim()
      return name && name !== 'HEAD' ? name : null
    } catch {
      return null
    }
  })

  ipcMain.handle('updates:check-now', async () => {
    if (isDev) return { ok: false, reason: 'dev mode' }
    try {
      const r = await autoUpdater.checkForUpdates()
      return { ok: true, hasUpdate: r?.updateInfo?.version !== app.getVersion(), version: r?.updateInfo?.version ?? null }
    } catch (e) {
      return { ok: false, reason: String((e as Error).message ?? e) }
    }
  })

  ipcMain.handle('updates:set-channel', (_e, channel: 'stable' | 'beta') => {
    if (isDev) return
    autoUpdater.allowPrerelease = channel === 'beta'
    autoUpdater.channel = channel === 'beta' ? 'beta' : 'latest'
  })

  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('app:open-external', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('errors:log-renderer', (_e, entry: { kind: string; message: string; stack?: string; context?: Record<string, unknown> }) => {
    appendErrorEntry({ source: 'renderer', ...entry })
  })
  ipcMain.handle('errors:reveal-log', () => revealErrorLog())

  ipcMain.handle('updates:install-now', () => {
    // Quit gracefully (firing before-quit, which flushes session state via
    // manager.dispose) and then relaunch with the staged update applied.
    autoUpdater.quitAndInstall(false, true)
  })

  ipcMain.handle('app:open-file', async (_e, opts: { path: string; line?: number; col?: number; cwd?: string; ide?: string }) => {
    const { resolve, isAbsolute } = await import('node:path')
    const abs = isAbsolute(opts.path)
      ? opts.path
      : resolve(opts.cwd || app.getPath('home'), opts.path)
    const ide = opts.ide || 'cursor'
    const lineCol = opts.line ? `:${opts.line}${opts.col ? `:${opts.col}` : ''}` : ''
    if (ide === 'finder') {
      shell.showItemInFolder(abs)
      return
    }
    const url = `${ide}://file${abs}${lineCol}`
    shell.openExternal(url)
  })

  ipcMain.handle('notify:awaiting', (_e, sessionId: string, sessionName: string) => {
    const s = settings.get()
    if (!s.notifications.systemNotifications) {
      if (process.platform === 'darwin') app.dock?.bounce('critical')
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
        mainWindow.flashFrame(true)
      }
      return
    }
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Claude is awaiting input',
        body: sessionName,
        silent: true
      })
      n.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          mainWindow.webContents.send('notification:click', sessionId)
        }
        app.focus({ steal: true })
      })
      n.show()
    }
    if (process.platform === 'darwin') {
      app.dock?.bounce('critical')
    }
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true)
    }
  })

  const safeSend = (channel: string, ...args: unknown[]): void => {
    if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) return
    const wc = mainWindow.webContents
    if (wc.isDestroyed()) return
    try {
      wc.send(channel, ...args)
    } catch {
      /* renderer frame may be mid-dispose; drop the message */
    }
  }

  manager.on('data', (id: string, data: string) => safeSend('tmux:data', id, data))
  manager.on('exit', (id: string) => {
    const cwd = cwdOf(id)
    safeSend('tmux:exit', id)
    if (cwd) recordSessionClosed(id, cwd)
  })
  manager.on('status', (id: string, status: string) => {
    safeSend('tmux:status', id, status)
    updateBadgeCount()
    const cwd = cwdOf(id)
    if (cwd && (status === 'working' || status === 'idle' || status === 'awaiting' || status === 'detached')) {
      recordStatusChange(id, cwd, status)
    }
  })
}

function updateBadgeCount(): void {
  if (process.platform !== 'darwin') return
  const statuses = manager.getStatuses()
  const count = Object.values(statuses).filter((s) => s === 'awaiting').length
  try {
    app.setBadgeCount(count)
  } catch {
    /* ignore */
  }
}

function buildAppMenu(): void {
  const send = (action: string): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('menu:action', action)
    }
  }
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'PikudClaude',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => send('settings')
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Session…', accelerator: 'CmdOrCtrl+N', click: () => send('new-session') },
        { label: 'Import Existing tmux…', click: () => send('import-session') },
        { type: 'separator' },
        {
          label: 'Bookmark Current Point',
          accelerator: 'CmdOrCtrl+B',
          click: () => send('bookmark')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+K',
          click: () => send('palette-all')
        },
        {
          label: 'Switch Session…',
          accelerator: 'CmdOrCtrl+P',
          click: () => send('palette-sessions')
        },
        {
          label: 'Find in Terminal…',
          accelerator: 'CmdOrCtrl+F',
          click: () => send('search')
        },
        {
          label: 'View Scrollback (selectable text)',
          accelerator: 'Shift+CmdOrCtrl+C',
          click: () => send('view-scrollback')
        },
        { type: 'separator' },
        { label: 'Toggle Bookmarks Panel', click: () => send('toggle-bookmarks') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'PikudClaude Help', click: () => send('help') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && existsSync(ICON_PATH)) {
    try {
      app.dock?.setIcon(nativeImage.createFromPath(ICON_PATH))
    } catch {
      /* ignore */
    }
  }
  await manager.init()
  wireIpc()
  await createWindow()
  buildAppMenu()

  // macOS wake-from-sleep handler. The status pollers, FS watchers, and tmux
  // server can all end up in stale states after the system suspends — re-
  // probe everything immediately and tell the renderer to re-sync its view.
  const handleResume = (): void => {
    void manager.refreshAfterResume().catch(() => undefined)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:resumed')
    }
  }
  powerMonitor.on('resume', handleResume)
  powerMonitor.on('unlock-screen', handleResume)

  if (!isDev) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    const s = settings.get()
    autoUpdater.allowPrerelease = s.updates.channel === 'beta'
    autoUpdater.channel = s.updates.channel === 'beta' ? 'beta' : 'latest'
    const broadcast = (status: string, payload?: unknown): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:status', { status, payload })
      }
    }
    autoUpdater.on('checking-for-update', () => broadcast('checking'))
    autoUpdater.on('update-available', (info) => broadcast('available', info))
    autoUpdater.on('update-not-available', () => broadcast('up-to-date'))
    autoUpdater.on('error', (err) => broadcast('error', String(err?.message ?? err)))
    autoUpdater.on('download-progress', (p) => broadcast('downloading', p))
    autoUpdater.on('update-downloaded', () => broadcast('downloaded'))
    if (s.updates.autoCheck) {
      autoUpdater.checkForUpdatesAndNotify().catch(() => undefined)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await manager.dispose()
})
