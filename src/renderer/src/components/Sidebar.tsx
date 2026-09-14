import { useState, useEffect, useRef } from 'react'
import {
  formatIdle,
  formatMB,
  STALE_SESSION_MS,
  type SessionVitals
} from '../../../shared/vitals'
import type { SessionMeta, SessionStatus } from '../types'
import { basename } from '../utils/path'
import { IS_MAC } from '../utils/platform'
import { isRtlText as isRtl } from '../../../shared/bidi'

const SESSION_COLORS = ['#7c3aed', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6']

// Grace after a session stops 'working' before its project's run-lock releases —
// absorbs the working↔idle flicker within a single turn so the disabled sibling
// row doesn't strobe. Released for real once the run stays finished this long.
const LOCK_GRACE_MS = 3000



interface Props {
  sessions: SessionMeta[]
  activeId: string | null
  statuses: Record<string, SessionStatus>
  promptHistory: Record<string, Array<{ text: string; ts: number }>>
  unseen: Set<string>
  needsAttention: Set<string>
  bookmarksOpen: boolean
  conversationOpen: boolean
  view: 'terminal' | 'dashboard' | 'stats'
  onSelect: (id: string) => void
  onNew: () => void
  onImport: () => void
  onHelp: () => void
  onTogglePalette: () => void
  onToggleBookmarks: () => void
  onToggleConversation: () => void
  onSettings: () => void
  onSetView: (v: 'terminal' | 'dashboard' | 'stats') => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onSetColor: (id: string, color: string) => void
  onReorder: (orderedIds: string[]) => void
}

export function Sidebar({
  sessions,
  activeId,
  statuses,
  promptHistory,
  unseen,
  needsAttention,
  bookmarksOpen,
  conversationOpen,
  view,
  onSelect,
  onNew,
  onHelp,
  onTogglePalette,
  onToggleBookmarks,
  onToggleConversation,
  onSettings,
  onSetView,
  onDelete,
  onRename,
  onSetColor,
  onReorder
}: Props): JSX.Element {
  const awaitingCount = sessions.reduce(
    (n, s) => (statuses[s.id] === 'awaiting' ? n + 1 : n),
    0
  )

  // Every live session holds a Claude Code process. On a memory-constrained
  // machine, knowing which ones have been sitting untouched for days is the
  // difference between a responsive app and a thrashing one — and the app
  // already has the data, it just never showed it. Costs three subprocesses per
  // poll regardless of session count, so a slow timer is plenty.
  const [vitals, setVitals] = useState<Record<string, SessionVitals>>({})
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      if (document.hidden) return
      window.api
        .getSessionVitals()
        .then((rows) => {
          if (!alive) return
          const byId: Record<string, SessionVitals> = {}
          for (const r of rows) byId[r.id] = r
          setVitals(byId)
        })
        .catch(() => undefined)
    }
    refresh()
    const t = window.setInterval(refresh, 30_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      alive = false
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  const stale = sessions.filter(
    (s) => (vitals[s.id]?.idleMs ?? 0) > STALE_SESSION_MS
  )
  const staleMB = stale.reduce((n, s) => n + (vitals[s.id]?.rssMB ?? 0), 0)
  // How many sessions share each folder — drives the "⧉ ×N" badge that flags
  // duplicate-cwd sessions (the same-project case that confuses the
  // conversation panel's per-session JSONL resolution).
  const cwdCounts = new Map<string, number>()
  for (const s of sessions) {
    const k = normCwd(s.cwd)
    if (k) cwdCounts.set(k, (cwdCounts.get(k) ?? 0) + 1)
  }
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [colorPickerId, setColorPickerId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropPosition, setDropPosition] = useState<'above' | 'below' | null>(null)
  const [usage, setUsage] = useState<{
    totalTokens: number
    costUSD: number
    msUntilReset: number
    percentUsed: number | null
    costPerHour: number | null
    tokensPerMinute: number | null
    projectedCost: number | null
    projectedTokens: number | null
  } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Per-project run lock: while a session on a cwd is 'working', the OTHER
  // sessions on that cwd are disabled. `lockedBy` maps cwd → the id of the
  // session holding the lock; a sibling is disabled iff another id holds its
  // cwd's lock. Released a grace period after the holder's run finishes.
  const [lockedBy, setLockedBy] = useState<Map<string, string>>(new Map())
  const lockedByRef = useRef(lockedBy)
  lockedByRef.current = lockedBy
  const releaseTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    let mounted = true
    const fetchUsage = (): void => {
      // Skip while the window is hidden/minimized — main-side result caching
      // makes each IPC cheap, but there's no reason to refresh a strip nobody
      // can see. The visibilitychange listener below refreshes on return.
      if (document.hidden) return
      window.api
        .getActiveBlock()
        .then((b) => {
          if (mounted) setUsage(b)
        })
        .catch(() => undefined)
    }
    fetchUsage()
    // The heavy ccusage spawn is cached in the main process (usage.ts), so
    // this poll + focus refresh mostly hits the cache; poll keeps the
    // countdown fresh, focus catches an expired cache right when the user
    // looks at the window.
    const interval = setInterval(fetchUsage, 2 * 60 * 1000)
    const onFocus = (): void => fetchUsage()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      mounted = false
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  useEffect(() => {
    if (!colorPickerId) return
    const close = (): void => setColorPickerId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [colorPickerId])

  // Maintain the per-project run lock from live statuses. Acquire/refresh
  // immediately when a session is 'working'; schedule release once its cwd has
  // no working session, after LOCK_GRACE_MS (cancelled if working resumes).
  useEffect(() => {
    const working = new Map<string, string>() // cwd -> working session id
    for (const s of sessions) {
      if (statuses[s.id] === 'working') {
        const k = normCwd(s.cwd)
        if (k) working.set(k, s.id)
      }
    }
    const next = new Map(lockedByRef.current)
    let changed = false
    for (const [k, id] of working) {
      if (next.get(k) !== id) {
        next.set(k, id)
        changed = true
      }
      const pending = releaseTimers.current.get(k)
      if (pending) {
        clearTimeout(pending)
        releaseTimers.current.delete(k)
      }
    }
    for (const k of next.keys()) {
      if (!working.has(k) && !releaseTimers.current.has(k)) {
        const timer = setTimeout(() => {
          releaseTimers.current.delete(k)
          setLockedBy((prev) => {
            const n = new Map(prev)
            n.delete(k)
            return n
          })
        }, LOCK_GRACE_MS)
        releaseTimers.current.set(k, timer)
      }
    }
    if (changed) setLockedBy(next)
  }, [statuses, sessions])

  useEffect(() => {
    const timers = releaseTimers.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  const startEdit = (s: SessionMeta): void => {
    setEditingId(s.id)
    setEditValue(s.name)
  }

  const commitEdit = (): void => {
    if (editingId) onRename(editingId, editValue)
    setEditingId(null)
  }

  const cancelEdit = (): void => {
    setEditingId(null)
  }

  const handleDragStart = (e: React.DragEvent, id: string): void => {
    setDraggingId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }

  const handleDragOver = (e: React.DragEvent, id: string): void => {
    if (!draggingId || draggingId === id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    setDropTargetId(id)
    setDropPosition(e.clientY < midY ? 'above' : 'below')
  }

  const handleDragEnd = (): void => {
    setDraggingId(null)
    setDropTargetId(null)
    setDropPosition(null)
  }

  const handleDrop = (e: React.DragEvent, targetId: string): void => {
    e.preventDefault()
    const draggedId = e.dataTransfer.getData('text/plain') || draggingId
    if (!draggedId || draggedId === targetId) {
      handleDragEnd()
      return
    }
    const ordered = sessions.map((s) => s.id).filter((id) => id !== draggedId)
    let targetIndex = ordered.indexOf(targetId)
    if (dropPosition === 'below') targetIndex++
    ordered.splice(targetIndex, 0, draggedId)
    onReorder(ordered)
    handleDragEnd()
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title">PikudClaude <span className="sidebar-title-by">by WMG</span></div>
        <div className="sidebar-buttons">
          <button className="add-btn" onClick={onTogglePalette} title="Command palette (⌘K)">⌘K</button>
          <button
            className={`add-btn ${conversationOpen ? 'on' : ''}`}
            onClick={onToggleConversation}
            title={`Conversation panel (${IS_MAC ? '⌘J' : 'Ctrl+Shift+J'})`}
          >💬</button>
          <button
            className={`add-btn ${bookmarksOpen ? 'on' : ''}`}
            onClick={onToggleBookmarks}
            title="Toggle bookmarks (⌘B to add)"
          >★</button>
          <button className="add-btn" onClick={onSettings} title="Settings (⌘,)">⚙</button>
          <button className="add-btn" onClick={onNew} title="New session (also: import existing)">+</button>
        </div>
      </div>
      <div className="sidebar-view-switch" role="tablist" aria-label="View">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'terminal'}
          className={`sidebar-view-tab ${view === 'terminal' ? 'active' : ''}`}
          onClick={() => onSetView('terminal')}
        >
          Terminal
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'dashboard'}
          className={`sidebar-view-tab ${view === 'dashboard' ? 'active' : ''}`}
          onClick={() => onSetView('dashboard')}
          title={`Dashboard (${IS_MAC ? '⌘D' : 'Ctrl+Shift+D'})`}
        >
          Dashboard
          {awaitingCount > 0 && (
            <span className="sidebar-view-badge" title={`${awaitingCount} awaiting`}>
              {awaitingCount}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'stats'}
          className={`sidebar-view-tab ${view === 'stats' ? 'active' : ''}`}
          onClick={() => onSetView('stats')}
          title="Stats"
        >
          Stats
        </button>
      </div>
      <div className="sidebar-list">
        {stale.length > 0 && (
          <div
            className="idle-summary"
            title={stale.map((s) => s.name).join('\n')}
          >
            {stale.length} idle over a day
            {staleMB > 0 && ` · ${formatMB(staleMB)} resident`}
          </div>
        )}
        {sessions.length === 0 && (
          <div className="empty-state">
            no sessions.<br />
            click <strong>+</strong> to create or import a tmux session.
          </div>
        )}
        {sessions.map((s, i) => {
          const status = statuses[s.id] ?? 'detached'
          const isEditing = editingId === s.id
          const sharedCount = cwdCounts.get(normCwd(s.cwd)) ?? 1
          const lockHolder = lockedBy.get(normCwd(s.cwd))
          const isLockedOut = !!lockHolder && lockHolder !== s.id
          const isUnseen = unseen.has(s.id)
          const needsAttn = needsAttention.has(s.id)
          const isDragging = draggingId === s.id
          const isDropTarget = dropTargetId === s.id
          return (
            <div
              key={s.id}
              draggable={!isEditing && !isLockedOut}
              onDragStart={(e) => handleDragStart(e, s.id)}
              onDragOver={(e) => handleDragOver(e, s.id)}
              onDrop={(e) => handleDrop(e, s.id)}
              onDragEnd={handleDragEnd}
              onDragLeave={() => {
                if (dropTargetId === s.id) {
                  setDropTargetId(null)
                  setDropPosition(null)
                }
              }}
              className={`session-row ${activeId === s.id ? 'active' : ''} ${needsAttn ? 'needs-attn' : ''} ${isUnseen ? 'unseen' : ''} ${isDragging ? 'dragging' : ''} ${isDropTarget && dropPosition ? `drop-${dropPosition}` : ''} ${isLockedOut ? 'locked-out' : ''}`}
              style={isLockedOut ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              onClick={() => {
                if (isEditing || isLockedOut) return
                onSelect(s.id)
              }}
            >
              <div
                className={`session-dot ${status === 'shell' || status === 'detached' ? 'inactive' : ''}`}
                style={{ background: status === 'shell' || status === 'detached' ? '#3b3b46' : s.color }}
                title={status === 'shell' ? 'Claude not running — click to change color' : 'Click to change color'}
                onClick={(e) => {
                  e.stopPropagation()
                  setColorPickerId(colorPickerId === s.id ? null : s.id)
                }}
              />
              {colorPickerId === s.id && (
                <div className="session-color-picker" onClick={(e) => e.stopPropagation()}>
                  {SESSION_COLORS.map((c) => (
                    <div
                      key={c}
                      className={`color-swatch ${c === s.color ? 'selected' : ''}`}
                      style={{ background: c }}
                      onClick={() => {
                        onSetColor(s.id, c)
                        setColorPickerId(null)
                      }}
                    />
                  ))}
                </div>
              )}
              <div className="session-info">
                <div className="session-name-row">
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      className="rename-input"
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelEdit()
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="session-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        startEdit(s)
                      }}
                      title="Double-click to rename"
                    >
                      {s.name}
                    </span>
                  )}
                  {s.imported && !isEditing && (
                    <span className="imported-badge" title={`imported from tmux: ${s.tmuxName}`}>↥</span>
                  )}
                  {sharedCount > 1 && !isEditing && (
                    <span
                      title={`${sharedCount} sessions share this folder — may confuse the conversation panel`}
                      style={{ fontSize: 10, opacity: 0.55, marginInlineStart: 4, cursor: 'default' }}
                    >
                      ⧉×{sharedCount}
                    </span>
                  )}
                  {isLockedOut && !isEditing && (
                    <span
                      title="another session on this project is running — unlocks when it finishes"
                      style={{ fontSize: 10, marginInlineStart: 4, cursor: 'not-allowed' }}
                    >
                      🔒
                    </span>
                  )}
                </div>
                <div className="session-cwd">{basename(s.cwd) || s.tmuxName}</div>
                {(() => {
                  const v = vitals[s.id]
                  if (!v || v.idleMs === null || v.idleMs <= STALE_SESSION_MS) return null
                  return (
                    <div
                      className="session-idle"
                      title={
                        'Untouched for a while and still holding a live Claude process. ' +
                        'Memory shown is resident only — a swapped-out session costs more ' +
                        'than this figure suggests.'
                      }
                    >
                      idle {formatIdle(v.idleMs)}
                      {v.rssMB !== null && ` · ${formatMB(v.rssMB)}`}
                    </div>
                  )
                })()}
                {promptHistory[s.id]?.[0]?.text && (
                  <div
                    className="session-prompt"
                    dir={isRtl(promptHistory[s.id][0].text) ? 'rtl' : 'ltr'}
                    title={promptHistory[s.id][0].text}
                  >
                    {promptHistory[s.id][0].text}
                  </div>
                )}
              </div>
              <div className={`status-icon ${status}`} title={statusLabel(status)} />
              {(isUnseen || needsAttn) && (
                <div
                  className={`attn-dot ${needsAttn ? 'urgent' : ''}`}
                  title={needsAttn ? 'awaiting your input' : 'finished while you were away'}
                />
              )}
              {i < 9 && (
                <div className="session-shortcut" title={`Cmd+${i + 1}`}>⌘{i + 1}</div>
              )}
              <div className="session-actions">
                <button
                  className="icon-btn danger"
                  title={s.imported ? 'Remove from sidebar (keeps tmux session alive)' : 'Kill session'}
                  onClick={(e) => {
                    e.stopPropagation()
                    const msg = s.imported
                      ? `Remove "${s.name}" from sidebar?\n\nThe tmux session "${s.tmuxName}" will keep running — you can re-import it later.`
                      : `Kill session "${s.name}"?`
                    if (confirm(msg)) onDelete(s.id)
                  }}
                >
                  {s.imported ? '⊖' : '🗑'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <div
        className="sidebar-footer"
        title={
          usage
            ? `5-hour block · ${formatTokens(usage.totalTokens)} tokens · resets in ${formatDuration(usage.msUntilReset)}${usage.percentUsed != null ? ` · ${usage.percentUsed.toFixed(1)}% of historical max` : ''}`
            : 'no active 5-hour usage block'
        }
      >
        {usage ? (
          <>
            <div className="usage-row usage-headline">
              <span className="usage-cost">{formatUSD(usage.costUSD)}</span>
              <span className="usage-reset">↻ {formatDuration(usage.msUntilReset)}</span>
            </div>
            {usage.percentUsed != null && (
              <div className="usage-bar">
                <div
                  className="usage-bar-fill"
                  style={{ width: `${Math.min(100, usage.percentUsed)}%` }}
                />
                <span className="usage-pct-overlay">{Math.round(usage.percentUsed)}%</span>
              </div>
            )}
            <div className="usage-grid">
              <div className="usage-stat">
                <span className="usage-stat-label">tokens</span>
                <span className="usage-stat-value">{formatTokens(usage.totalTokens)}</span>
              </div>
              {usage.costPerHour != null && (
                <div className="usage-stat">
                  <span className="usage-stat-label">burn</span>
                  <span className="usage-stat-value">{formatUSD(usage.costPerHour)}/h</span>
                </div>
              )}
              {usage.tokensPerMinute != null && (
                <div className="usage-stat">
                  <span className="usage-stat-label">tok/min</span>
                  <span className="usage-stat-value">{formatTokens(usage.tokensPerMinute)}</span>
                </div>
              )}
              {usage.projectedCost != null && usage.projectedCost > usage.costUSD && (
                <div className="usage-stat">
                  <span className="usage-stat-label">proj</span>
                  <span className="usage-stat-value">{formatUSD(usage.projectedCost)}</span>
                </div>
              )}
            </div>
          </>
        ) : (
          <span className="usage-empty">no active usage</span>
        )}
      </div>
    </aside>
  )
}

function normCwd(p: string): string {
  return (p || '').trim().replace(/\/+$/, '')
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

function formatUSD(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en')}`
  if (n >= 10) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'working': return 'claude is working…'
    case 'idle': return 'idle — waiting for you'
    case 'awaiting': return 'awaiting your decision (1 / 2 / 3)'
    case 'detached': return 'not attached'
    case 'shell': return 'shell only — claude not running'
  }
}
