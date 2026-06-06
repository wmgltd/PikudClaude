import { useEffect, useState, useCallback, useRef } from 'react'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { TerminalView } from './components/TerminalView'
import { NewSessionDialog } from './components/NewSessionDialog'
import { ImportSessionDialog } from './components/ImportSessionDialog'
import { CommandPalette } from './components/CommandPalette'
import type { PaletteAction } from './components/CommandPalette'
import { BookmarksPanel } from './components/BookmarksPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { UpdateAvailableDialog } from './components/UpdateAvailableDialog'
import { WelcomeDialog } from './components/WelcomeDialog'
import { ScrollbackOverlay } from './components/ScrollbackOverlay'
import { Dashboard } from './components/Dashboard'
import { StatsView } from './components/StatsView'
import { ConversationPanel } from './components/ConversationPanel'
import { IS_MAC } from './utils/platform'
import type { SessionMeta, SessionStatus, Settings } from './types'
import { resolveTheme } from './types'

const DEFAULT_SETTINGS: Settings = {
  notifications: {
    soundEnabled: true,
    soundType: 'chime',
    volume: 0.4,
    systemNotifications: true,
    onlyWhenUnfocused: false,
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00'
  },
  sessions: {
    defaultInitialCommand: 'claude',
    defaultCwd: '',
    defaultColor: '#7c3aed',
    autoBookmarkOnAwaiting: false,
    autoBookmarkOnPrompt: false,
    trackPrompts: true,
    recentProjectsMax: 6,
    preferredIDE: 'cursor'
  },
  appearance: {
    fontSize: 13,
    fontFamily: 'Menlo, "SF Mono", Monaco, "Courier New", "Arial Hebrew", "Lucida Sans Unicode", monospace',
    lineHeight: 1.15,
    cursorStyle: 'block',
    cursorBlink: true,
    theme: 'default',
    customTheme: {
      background: '#000000',
      foreground: '#e4e4ec',
      cursor: '#7c3aed',
      selectionBackground: '#7c3aed55'
    }
  },
  ui: {
    welcomeShown: false
  }
}

function inQuietHours(start: string, end: string, now = new Date()): boolean {
  const parse = (s: string): number => {
    const [h, m] = s.split(':').map(Number)
    return (h ?? 0) * 60 + (m ?? 0)
  }
  const cur = now.getHours() * 60 + now.getMinutes()
  const s = parse(start)
  const e = parse(end)
  if (s === e) return false
  if (s < e) return cur >= s && cur < e
  return cur >= s || cur < e
}

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 500
const SIDEBAR_DEFAULT = 240
const SIDEBAR_STORAGE_KEY = 'pikudclaude.sidebarWidth'

function loadSidebarWidth(): number {
  const v = Number(localStorage.getItem(SIDEBAR_STORAGE_KEY))
  if (!Number.isFinite(v) || v < SIDEBAR_MIN || v > SIDEBAR_MAX) return SIDEBAR_DEFAULT
  return v
}

let sharedAudioCtx: AudioContext | null = null

function getAudioCtx(): AudioContext | null {
  if (sharedAudioCtx) {
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => undefined)
    }
    return sharedAudioCtx
  }
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    sharedAudioCtx = new Ctor()
    return sharedAudioCtx
  } catch {
    return null
  }
}

function primeAudio(): void {
  const ctx = getAudioCtx()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => undefined)
}

function playAwaitingSound(volume = 0.4, soundType: 'chime' | 'beep' = 'chime'): void {
  const ctx = getAudioCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') ctx.resume().catch(() => undefined)
  const peak = Math.max(0.001, Math.min(2, volume))
  try {
    const t = ctx.currentTime
    const playTone = (freq: number, start: number, duration: number, type: OscillatorType = 'sine'): void => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = type
      osc.frequency.setValueAtTime(freq, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + duration + 0.05)
    }
    if (soundType === 'beep') {
      playTone(1000, t, 0.12, 'square')
    } else {
      playTone(880, t, 0.22)
      playTone(660, t + 0.18, 0.32)
    }
  } catch {
    /* tone failed */
  }
}

export function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<'notifications' | 'sessions' | 'appearance' | 'shortcuts' | 'about'>('notifications')
  const [showPalette, setShowPalette] = useState(false)
  const [paletteMode, setPaletteMode] = useState<'all' | 'sessions'>('all')
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [showConversation, setShowConversation] = useState(false)
  const [showScrollback, setShowScrollback] = useState(false)
  const [scrollbackInitialSearch, setScrollbackInitialSearch] = useState<string | undefined>(
    undefined
  )
  const [view, setView] = useState<'terminal' | 'dashboard' | 'stats'>('terminal')
  const [promptHistory, setPromptHistory] = useState<
    Record<string, Array<{ text: string; ts: number }>>
  >({})
  const [promptStats, setPromptStats] = useState<Record<string, number[]>>({})
  const promptHistoryLoadedRef = useRef(false)
  const promptStatsLoadedRef = useRef(false)
  const [bookmarksRefresh, setBookmarksRefresh] = useState(0)
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({})
  const [unseen, setUnseen] = useState<Set<string>>(new Set())
  const [needsAttention, setNeedsAttention] = useState<Set<string>>(new Set())
  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSidebarWidth)
  const draggingRef = useRef(false)
  const prevStatusRef = useRef<Record<string, SessionStatus>>({})
  const activeIdRef = useRef<string | null>(null)
  const sessionsRef = useRef<SessionMeta[]>([])
  // Sessions the user has actually opened in this run. We lazy-mount
  // TerminalView so a fresh launch with 10 sessions doesn't spin up 10
  // xterm.js instances + IPC subscriptions before the user touches them.
  // Once a session is visited it stays mounted to keep fast switching.
  const [visitedIds, setVisitedIds] = useState<Set<string>>(new Set())
  // Awaiting alerts fire only after the status has been 'awaiting' for this
  // long. Prevents a duplicate notification when Claude flickers awaiting →
  // working → awaiting on a single message round-trip.
  const awaitingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Update prompt — shows a dialog whenever the auto-updater finds a new
  // version on launch. "Skip" hides it for the rest of this session; the
  // update still installs on next quit (autoInstallOnAppQuit). Reset by
  // restarting the app.
  const [updateInfo, setUpdateInfo] = useState<{
    version: string
    state: 'downloading' | 'ready'
    progressPercent?: number
  } | null>(null)
  const [updateSkipped, setUpdateSkipped] = useState(false)
  const updateSkippedRef = useRef(false)
  const AWAITING_DEBOUNCE_MS = 400

  useEffect(() => {
    activeIdRef.current = activeId
    if (activeId) {
      setVisitedIds((prev) => {
        if (prev.has(activeId)) return prev
        const next = new Set(prev)
        next.add(activeId)
        return next
      })
    }
  }, [activeId])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  // Listen for updater status from the main process. We watch globally so
  // the in-app update prompt opens at any time during the session — even
  // when Settings is closed. Skip dismisses for the session only; the
  // update still installs on next quit (autoInstallOnAppQuit is true).
  useEffect(() => {
    return window.api.onUpdateStatus((status, payload) => {
      if (updateSkippedRef.current) return

      if (status === 'available' && payload && typeof payload === 'object' && 'version' in payload) {
        const version = String((payload as { version: unknown }).version || '')
        setUpdateInfo({ version, state: 'downloading' })
        return
      }
      if (status === 'downloading' && payload && typeof payload === 'object' && 'percent' in payload) {
        const percent = (payload as { percent: number }).percent
        setUpdateInfo((prev) =>
          prev ? { ...prev, state: 'downloading', progressPercent: percent } : prev
        )
        return
      }
      if (status === 'downloaded') {
        setUpdateInfo((prev) => (prev ? { ...prev, state: 'ready' } : prev))
        return
      }
    })
  }, [])

  // Forward renderer-side uncaught errors to the main-process log so we have
  // a single place to look when something breaks on a user's machine.
  useEffect(() => {
    const onError = (e: ErrorEvent): void => {
      window.api
        .logRendererError({
          kind: 'window.onerror',
          message: e.message || String(e.error),
          stack: e.error instanceof Error ? e.error.stack : undefined,
          context: { filename: e.filename, lineno: e.lineno, colno: e.colno }
        })
        .catch(() => undefined)
    }
    const onRejection = (e: PromiseRejectionEvent): void => {
      const reason = e.reason
      const err = reason instanceof Error ? reason : new Error(String(reason))
      window.api
        .logRendererError({
          kind: 'unhandledRejection',
          message: err.message,
          stack: err.stack
        })
        .catch(() => undefined)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  const refresh = useCallback(async () => {
    const list = await window.api.listSessions()
    setSessions(list)
    if (list.length > 0 && !list.find((s) => s.id === activeId)) {
      setActiveId(list[0].id)
    }
    if (list.length === 0) setActiveId(null)
    const initial = await window.api.getStatuses()
    setStatuses(initial)
    prevStatusRef.current = initial
  }, [activeId])

  useEffect(() => {
    refresh()
    window.api
      .getSettings()
      .then((s) => {
        setSettings(s)
        settingsRef.current = s
      })
      .catch(() => undefined)
    window.api
      .loadPromptHistory()
      .then((p) => {
        setPromptHistory(p || {})
        promptHistoryLoadedRef.current = true
      })
      .catch(() => {
        promptHistoryLoadedRef.current = true
      })
    window.api
      .loadPromptStats()
      .then((s) => {
        setPromptStats(s || {})
        promptStatsLoadedRef.current = true
      })
      .catch(() => {
        promptStatsLoadedRef.current = true
      })
  }, [])

  useEffect(() => {
    if (!promptHistoryLoadedRef.current) return
    const t = setTimeout(() => {
      window.api.savePromptHistory(promptHistory).catch(() => undefined)
    }, 400)
    return () => clearTimeout(t)
  }, [promptHistory])

  useEffect(() => {
    if (!promptStatsLoadedRef.current) return
    const t = setTimeout(() => {
      window.api.savePromptStats(promptStats).catch(() => undefined)
    }, 400)
    return () => clearTimeout(t)
  }, [promptStats])

  // Prune prompts for sessions that no longer exist (deleted while the app
  // was closed, etc).
  useEffect(() => {
    if (!promptHistoryLoadedRef.current) return
    if (sessions.length === 0) return
    const ids = new Set(sessions.map((s) => s.id))
    setPromptHistory((prev) => {
      let changed = false
      const next: Record<string, string> = {}
      for (const [id, p] of Object.entries(prev)) {
        if (ids.has(id)) next[id] = p
        else changed = true
      }
      return changed ? next : prev
    })
  }, [sessions])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    return window.api.onNotificationClick((id) => setActiveId(id))
  }, [])

  // Conv-panel bubble click → open ScrollbackOverlay with the snippet
  // highlighted. We don't try to scroll xterm itself: while Claude is
  // running it owns the alt-screen, so xterm's normal-buffer scrollback is
  // empty. The overlay captures tmux's pane buffer, which is the only place
  // the old content is actually available.
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<string>).detail
      if (!detail) return
      setScrollbackInitialSearch(detail)
      setShowScrollback(true)
    }
    window.addEventListener('pk:jump-to-text', handler as EventListener)
    return () => window.removeEventListener('pk:jump-to-text', handler as EventListener)
  }, [])

  useEffect(() => {
    return window.api.onMenuAction((action) => {
      switch (action) {
        case 'new-session':
          setShowNewDialog(true)
          break
        case 'import-session':
          setShowImportDialog(true)
          break
        case 'settings':
          setShowSettings(true)
          break
        case 'palette-all':
          setPaletteMode('all')
          setShowPalette(true)
          break
        case 'palette-sessions':
          setPaletteMode('sessions')
          setShowPalette(true)
          break
        case 'toggle-bookmarks':
          setShowBookmarks((v) => !v)
          break
        case 'help':
          setSettingsInitialTab('shortcuts')
          setShowSettings(true)
          break
        case 'bookmark': {
          const id = activeIdRef.current
          if (!id) break
          const label = `Bookmark ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
          window.api.createBookmark(id, label).then(() => {
            setBookmarksRefresh((n) => n + 1)
            setShowBookmarks(true)
          })
          break
        }
        case 'view-scrollback': {
          if (!activeIdRef.current) break
          setShowScrollback(true)
          break
        }
        case 'search': {
          /* dispatch to active TerminalView via synthetic keydown */
          const ev = new KeyboardEvent('keydown', {
            key: 'f',
            metaKey: true,
            bubbles: true
          })
          window.dispatchEvent(ev)
          break
        }
      }
    })
  }, [])

  useEffect(() => {
    const onFirstGesture = (): void => {
      primeAudio()
      window.removeEventListener('mousedown', onFirstGesture)
      window.removeEventListener('keydown', onFirstGesture)
    }
    window.addEventListener('mousedown', onFirstGesture, { once: true })
    window.addEventListener('keydown', onFirstGesture, { once: true })
    return () => {
      window.removeEventListener('mousedown', onFirstGesture)
      window.removeEventListener('keydown', onFirstGesture)
    }
  }, [])

  useEffect(() => {
    return window.api.onSessionExit((id) => {
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setActiveId((prev) => (prev === id ? null : prev))
      setVisitedIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setPromptHistory((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      setPromptStats((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
    })
  }, [])

  useEffect(() => {
    const fireAwaitingAlerts = (id: string): void => {
      // Status may have changed in the time between the debounce timer being
      // set and now. Re-check before firing — the timer's cancel path should
      // also have run, but belt-and-suspenders.
      const cur = prevStatusRef.current[id]
      if (cur !== 'awaiting') return
      if (id === activeIdRef.current) return

      setNeedsAttention((u) => new Set(u).add(id))
      const s = settingsRef.current
      const focused = document.hasFocus()
      const quiet =
        s.notifications.quietHoursEnabled &&
        inQuietHours(s.notifications.quietHoursStart, s.notifications.quietHoursEnd)
      const suppress = quiet || (s.notifications.onlyWhenUnfocused && focused)
      if (!suppress && s.notifications.soundEnabled) {
        playAwaitingSound(s.notifications.volume, s.notifications.soundType)
      }
      const session = sessionsRef.current.find((sess) => sess.id === id)
      if (!suppress && s.notifications.systemNotifications) {
        window.api.notifyAwaiting(id, session?.name ?? 'session').catch(() => undefined)
      }
      if (s.sessions.autoBookmarkOnAwaiting && session) {
        const label = `auto: awaiting ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
        window.api
          .createBookmark(id, label)
          .then(() => {
            setBookmarksRefresh((n) => n + 1)
          })
          .catch(() => undefined)
      }
    }

    return window.api.onSessionStatus((id, status) => {
      setStatuses((prev) => {
        const prevStatus = prev[id]
        const next = { ...prev, [id]: status }
        const isActive = id === activeIdRef.current

        // If status moves away from awaiting, cancel any pending alert that
        // hasn't fired yet — Claude flickered, we don't want to spam.
        if (status !== 'awaiting') {
          const pending = awaitingTimersRef.current.get(id)
          if (pending) {
            clearTimeout(pending)
            awaitingTimersRef.current.delete(id)
          }
        }

        if (!isActive) {
          if (prevStatus === 'working' && status === 'idle') {
            setUnseen((u) => new Set(u).add(id))
          }
          if (status === 'awaiting' && prevStatus !== 'awaiting') {
            // Update prevStatusRef synchronously so the timer callback sees
            // the right value when it re-checks.
            prevStatusRef.current = next
            const existing = awaitingTimersRef.current.get(id)
            if (existing) clearTimeout(existing)
            const handle = setTimeout(() => {
              awaitingTimersRef.current.delete(id)
              fireAwaitingAlerts(id)
            }, AWAITING_DEBOUNCE_MS)
            awaitingTimersRef.current.set(id, handle)
          }
        }
        prevStatusRef.current = next
        return next
      })
    })
  }, [])

  // Cancel any pending awaiting timers when a session exits, to avoid firing
  // notifications for sessions that no longer exist.
  useEffect(() => {
    return window.api.onSessionExit((id) => {
      const pending = awaitingTimersRef.current.get(id)
      if (pending) {
        clearTimeout(pending)
        awaitingTimersRef.current.delete(id)
      }
    })
  }, [])

  useEffect(() => {
    if (!activeId) return
    setUnseen((u) => {
      if (!u.has(activeId)) return u
      const next = new Set(u)
      next.delete(activeId)
      return next
    })
    setNeedsAttention((u) => {
      if (!u.has(activeId)) return u
      const next = new Set(u)
      next.delete(activeId)
      return next
    })
  }, [activeId])

  useEffect(() => {
    const modalOpen = showNewDialog || showImportDialog || showPalette || showSettings
    if (modalOpen && !showPalette) return
    const handler = (e: KeyboardEvent) => {
      // On macOS, the app-level modifier is ⌘ (metaKey). On Windows/Linux,
      // it's Ctrl (ctrlKey). Require the right one for the platform and
      // reject the wrong one — otherwise Ctrl+letter combos that are
      // sacred in shells (Ctrl+C, Ctrl+D, Ctrl+R…) would silently get
      // hijacked on Mac when the user only wanted a shell action.
      const mod = IS_MAC ? e.metaKey : e.ctrlKey
      const wrongMod = IS_MAC ? e.ctrlKey : e.metaKey
      if (!mod || wrongMod || e.altKey) return

      if (!e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteMode('all')
        setShowPalette((v) => !v)
        return
      }
      if (!e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPaletteMode('sessions')
        setShowPalette((v) => !v)
        return
      }
      if (!e.shiftKey && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
        return
      }
      if (modalOpen) return
      // Conversation panel: ⌘J on Mac, Ctrl+Shift+J on Windows. Ctrl+J is
      // newline in most shells and we don't want to swallow it.
      const wantsConv = IS_MAC
        ? !e.shiftKey && e.key.toLowerCase() === 'j'
        : e.shiftKey && e.key.toLowerCase() === 'j'
      if (wantsConv) {
        e.preventDefault()
        setShowConversation((v) => !v)
        return
      }
      if (e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        if (!activeIdRef.current) return
        setShowScrollback((v) => !v)
        return
      }
      if (!e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        const id = activeIdRef.current
        if (!id) return
        const label = `Bookmark ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
        window.api.createBookmark(id, label).then(() => {
          setBookmarksRefresh((n) => n + 1)
          setShowBookmarks(true)
        })
        return
      }
      // Dashboard: ⌘D on Mac, Ctrl+Shift+D on Windows (plain Ctrl+D is EOF
      // in every shell, so we don't dare hijack it without shift).
      const wantsDashboard = IS_MAC
        ? !e.shiftKey && (e.code === 'KeyD' || e.key.toLowerCase() === 'd')
        : e.shiftKey && (e.code === 'KeyD' || e.key.toLowerCase() === 'd')
      if (wantsDashboard) {
        e.preventDefault()
        setView((v) => (v === 'terminal' ? 'dashboard' : 'terminal'))
        return
      }
      if (!e.shiftKey) {
        const n = Number(e.key)
        if (Number.isInteger(n) && n >= 1 && n <= 9) {
          const target = sessions[n - 1]
          if (target) {
            e.preventDefault()
            setActiveId(target.id)
          }
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sessions, showNewDialog, showImportDialog, showPalette, showSettings])

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, ev.clientX))
      setSidebarWidth(w)
    }
    const onUp = () => {
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setSidebarWidth((current) => {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(current))
        return current
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleCreate = async (opts: {
    name: string
    cwd: string
    color: string
    initialCommand: string
  }) => {
    const meta = await window.api.createSession({
      name: opts.name,
      cwd: opts.cwd,
      color: opts.color,
      initialCommand: opts.initialCommand || undefined
    })
    setSessions((prev) => [meta, ...prev])
    setActiveId(meta.id)
    setShowNewDialog(false)
  }

  const handleImport = async (opts: {
    tmuxName: string
    displayName: string
    color: string
  }) => {
    const meta = await window.api.importSession(opts)
    setSessions((prev) => [meta, ...prev])
    setActiveId(meta.id)
    setShowImportDialog(false)
  }

  const handleDelete = async (id: string) => {
    await window.api.killSession(id)
    setSessions((prev) => prev.filter((s) => s.id !== id))
    setActiveId((prev) => (prev === id ? null : prev))
    setPromptHistory((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setPromptStats((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const handleRename = async (id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    await window.api.renameSession(id, trimmed)
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name: trimmed } : s)))
  }

  const handleSetColor = async (id: string, color: string): Promise<void> => {
    await window.api.setSessionColor(id, color)
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, color } : s)))
  }

  const handleReorder = async (orderedIds: string[]): Promise<void> => {
    setSessions((prev) => {
      const indexOf = new Map(orderedIds.map((id, i) => [id, i]))
      return [...prev].sort((a, b) => (indexOf.get(a.id) ?? 9999) - (indexOf.get(b.id) ?? 9999))
    })
    await window.api.reorderSessions(orderedIds)
  }

  const paletteActions: PaletteAction[] = [
    { id: 'new', label: 'New session', hint: '⌘+', run: () => setShowNewDialog(true) },
    { id: 'import', label: 'Import existing tmux session', hint: '⌘⤓', run: () => setShowImportDialog(true) },
    { id: 'help', label: 'Keyboard shortcuts', hint: '', run: () => {
      setSettingsInitialTab('shortcuts')
      setShowSettings(true)
    } },
    { id: 'settings', label: 'Settings', hint: '⌘,', run: () => setShowSettings(true) },
    { id: 'bookmark', label: 'Bookmark current point', hint: '⌘B', run: () => {
      const id = activeIdRef.current
      if (!id) return
      const label = `Bookmark ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
      window.api.createBookmark(id, label).then(() => {
        setBookmarksRefresh((n) => n + 1)
        setShowBookmarks(true)
      })
    }},
    { id: 'toggle-bookmarks', label: showBookmarks ? 'Hide bookmarks panel' : 'Show bookmarks panel', run: () => setShowBookmarks((v) => !v) },
    { id: 'view-scrollback', label: 'View scrollback (selectable text)', hint: '⌘⇧C', run: () => {
      if (!activeIdRef.current) return
      setShowScrollback(true)
    }}
  ]

  // Right-hand panels (conversation, bookmarks) each add their own column
  // when open. Conversation goes immediately to the right of the terminal;
  // bookmarks slot in as a thinner column past it.
  const gridCols = (() => {
    let cols = `${sidebarWidth}px 4px 1fr`
    if (showConversation) cols += ' 340px'
    if (showBookmarks) cols += ' 240px'
    return cols
  })()

  const activeSession = sessions.find((s) => s.id === activeId) ?? null

  return (
    <div className="app-shell">
      <TopBar
        session={activeSession}
        lastPrompt={activeId ? promptHistory[activeId]?.[0]?.text ?? null : null}
        lastPromptTs={activeId ? promptHistory[activeId]?.[0]?.ts ?? null : null}
        status={activeId ? statuses[activeId] : undefined}
        view={view}
        onToggleView={() => setView((v) => (v === 'terminal' ? 'dashboard' : 'terminal'))}
        onClearPromptHistory={
          activeId
            ? () =>
                setPromptHistory((prev) => {
                  if (!(activeId in prev)) return prev
                  const next = { ...prev }
                  delete next[activeId]
                  return next
                })
            : undefined
        }
      />
      <div className="app" style={{ gridTemplateColumns: gridCols }}>
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        statuses={statuses}
        promptHistory={promptHistory}
        unseen={unseen}
        needsAttention={needsAttention}
        view={view}
        onSetView={setView}
        onSelect={setActiveId}
        onNew={() => setShowNewDialog(true)}
        onImport={() => setShowImportDialog(true)}
        onHelp={() => {
          setSettingsInitialTab('shortcuts')
          setShowSettings(true)
        }}
        onTogglePalette={() => {
          setPaletteMode('all')
          setShowPalette((v) => !v)
        }}
        onToggleBookmarks={() => setShowBookmarks((v) => !v)}
        onToggleConversation={() => setShowConversation((v) => !v)}
        onSettings={() => setShowSettings(true)}
        bookmarksOpen={showBookmarks}
        conversationOpen={showConversation}
        onDelete={handleDelete}
        onRename={handleRename}
        onSetColor={handleSetColor}
        onReorder={handleReorder}
      />
      <div className="resizer" onMouseDown={startDrag} />
      <div
        className={`terminal-area view-${view}`}
        style={{ background: resolveTheme(settings.appearance).background }}
      >
        {view === 'dashboard' && (
          <Dashboard
            sessions={sessions}
            statuses={statuses}
            promptHistory={promptHistory}
            promptStats={promptStats}
            onFocus={(id) => {
              setActiveId(id)
              setView('terminal')
            }}
          />
        )}
        {view === 'stats' && <StatsView />}
        {sessions.length === 0 && view === 'terminal' && (
          <div className="terminal-empty">
            no sessions yet — hit <kbd>+</kbd> in the sidebar to start one
          </div>
        )}
        {sessions
          // Only mount terminals the user has actually visited. Active id is
          // always mounted (visitedIds is populated synchronously in the
          // activeId effect, but include it here as a belt-and-suspenders so
          // the first render after a switch never shows an empty pane).
          .filter((s) => s.id === activeId || visitedIds.has(s.id))
          .map((s) => (
            <TerminalView
              key={s.id}
              session={s}
              active={s.id === activeId}
              fontSize={settings.appearance.fontSize}
              fontFamily={settings.appearance.fontFamily}
              lineHeight={settings.appearance.lineHeight}
              cursorStyle={settings.appearance.cursorStyle}
              cursorBlink={settings.appearance.cursorBlink}
              theme={resolveTheme(settings.appearance)}
              preferredIDE={settings.sessions.preferredIDE}
              onOpenScrollback={() => setShowScrollback(true)}
              onPromptSubmit={(prompt) => {
                // Stats are recorded regardless of trackPrompts (which only
                // controls the per-session prompt history shown in the UI).
                // Stats stores only length+language, no text.
                window.api.recordPrompt(s.id, prompt).catch(() => undefined)
                if (!settingsRef.current.sessions.trackPrompts) return
                const now = Date.now()
                setPromptHistory((prev) => {
                  const cur = prev[s.id] ?? []
                  if (cur[0]?.text === prompt) return prev
                  const filtered = cur.filter((e) => e.text !== prompt)
                  const next = [{ text: prompt, ts: now }, ...filtered].slice(0, 20)
                  return { ...prev, [s.id]: next }
                })
                setPromptStats((prev) => {
                  const cur = prev[s.id] ?? []
                  return { ...prev, [s.id]: [...cur, now] }
                })
                if (settingsRef.current.sessions.autoBookmarkOnPrompt) {
                  const label = prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt
                  window.api.createBookmark(s.id, label).then(() => {
                    setBookmarksRefresh((n) => n + 1)
                  }).catch(() => undefined)
                }
              }}
            />
          ))}
      </div>
      {showConversation && (
        <ConversationPanel
          cwd={activeSession?.cwd ?? null}
          onClose={() => setShowConversation(false)}
        />
      )}
      {showBookmarks && (
        <BookmarksPanel
          sessionId={activeId}
          refreshKey={bookmarksRefresh}
          onClose={() => setShowBookmarks(false)}
        />
      )}
      {showNewDialog && (
        <NewSessionDialog
          onCreate={handleCreate}
          onCancel={() => setShowNewDialog(false)}
          onSwitchToImport={() => {
            setShowNewDialog(false)
            setShowImportDialog(true)
          }}
          defaultInitialCommand={settings.sessions.defaultInitialCommand}
          defaultCwd={settings.sessions.defaultCwd}
          defaultColor={settings.sessions.defaultColor}
          recentMax={settings.sessions.recentProjectsMax}
        />
      )}
      {showSettings && (
        <SettingsDialog
          initial={settings}
          initialTab={settingsInitialTab}
          onSave={async (next) => {
            const saved = await window.api.saveSettings(next)
            setSettings(saved)
            settingsRef.current = saved
            setShowSettings(false)
            setSettingsInitialTab('notifications')
          }}
          onCancel={() => {
            setShowSettings(false)
            setSettingsInitialTab('notifications')
          }}
          onTestSound={(v, t) => playAwaitingSound(v, t)}
          onShowOnboarding={async () => {
            const saved = await window.api.saveSettings({ ui: { welcomeShown: false } })
            setSettings(saved)
            settingsRef.current = saved
            setShowSettings(false)
            setSettingsInitialTab('notifications')
          }}
        />
      )}
      {showImportDialog && (
        <ImportSessionDialog
          onImport={handleImport}
          onCancel={() => setShowImportDialog(false)}
          onSwitchToNew={() => {
            setShowImportDialog(false)
            setShowNewDialog(true)
          }}
        />
      )}
      {showPalette && (
        <CommandPalette
          sessions={sessions}
          activeId={activeId}
          promptHistory={promptHistory}
          actions={paletteActions}
          onClose={() => setShowPalette(false)}
          onSelectSession={setActiveId}
          mode={paletteMode}
        />
      )}
      {showScrollback && activeId && (
        <ScrollbackOverlay
          sessionId={activeId}
          initialSearch={scrollbackInitialSearch}
          onClose={() => {
            setShowScrollback(false)
            setScrollbackInitialSearch(undefined)
          }}
        />
      )}
      {!settings.ui.welcomeShown && (
        <WelcomeDialog
          onDismiss={async (projectsRoot) => {
            const patch: Partial<Settings> = { ui: { welcomeShown: true } }
            if (projectsRoot) {
              patch.sessions = {
                ...(settings?.sessions ?? {}),
                projectsRoot,
                defaultCwd: settings?.sessions.defaultCwd || projectsRoot
              } as Settings['sessions']
            }
            const saved = await window.api.saveSettings(patch)
            setSettings(saved)
            settingsRef.current = saved
          }}
        />
      )}
      {updateInfo && !updateSkipped && (
        <UpdateAvailableDialog
          version={updateInfo.version}
          state={updateInfo.state}
          progressPercent={updateInfo.progressPercent}
          onUpdateNow={() => window.api.installUpdateNow()}
          onSkip={() => {
            updateSkippedRef.current = true
            setUpdateSkipped(true)
          }}
        />
      )}
      </div>
    </div>
  )
}
