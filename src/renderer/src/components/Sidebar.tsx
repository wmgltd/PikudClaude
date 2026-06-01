import { useState, useEffect, useRef } from 'react'
import type { SessionMeta, SessionStatus } from '../types'
import { basename } from '../utils/path'

const SESSION_COLORS = ['#7c3aed', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6']

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/

function isRtl(text: string): boolean {
  return RTL_RE.test(text)
}

interface Props {
  sessions: SessionMeta[]
  activeId: string | null
  statuses: Record<string, SessionStatus>
  promptHistory: Record<string, Array<{ text: string; ts: number }>>
  unseen: Set<string>
  needsAttention: Set<string>
  bookmarksOpen: boolean
  view: 'terminal' | 'dashboard'
  onSelect: (id: string) => void
  onNew: () => void
  onImport: () => void
  onHelp: () => void
  onTogglePalette: () => void
  onToggleBookmarks: () => void
  onSettings: () => void
  onSetView: (v: 'terminal' | 'dashboard') => void
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
  view,
  onSelect,
  onNew,
  onHelp,
  onTogglePalette,
  onToggleBookmarks,
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

  useEffect(() => {
    let mounted = true
    const fetchUsage = (): void => {
      window.api
        .getActiveBlock()
        .then((b) => {
          if (mounted) setUsage(b)
        })
        .catch(() => undefined)
    }
    fetchUsage()
    // Cheap-ish call (parses cached ccusage data); poll faster than the
    // original 10min so a refreshed Claude session shows up quickly. Also
    // refresh whenever the window regains focus — the user explicitly came
    // back, they want fresh numbers, not a cached snapshot.
    const interval = setInterval(fetchUsage, 2 * 60 * 1000)
    const onFocus = (): void => fetchUsage()
    window.addEventListener('focus', onFocus)
    return () => {
      mounted = false
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
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
          title="Dashboard (⌘D)"
        >
          Dashboard
          {awaitingCount > 0 && (
            <span className="sidebar-view-badge" title={`${awaitingCount} awaiting`}>
              {awaitingCount}
            </span>
          )}
        </button>
      </div>
      <div className="sidebar-list">
        {sessions.length === 0 && (
          <div className="empty-state">
            no sessions.<br />
            click <strong>+</strong> to create or import a tmux session.
          </div>
        )}
        {sessions.map((s, i) => {
          const status = statuses[s.id] ?? 'detached'
          const isEditing = editingId === s.id
          const isUnseen = unseen.has(s.id)
          const needsAttn = needsAttention.has(s.id)
          const isDragging = draggingId === s.id
          const isDropTarget = dropTargetId === s.id
          return (
            <div
              key={s.id}
              draggable={!isEditing}
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
              className={`session-row ${activeId === s.id ? 'active' : ''} ${needsAttn ? 'needs-attn' : ''} ${isUnseen ? 'unseen' : ''} ${isDragging ? 'dragging' : ''} ${isDropTarget && dropPosition ? `drop-${dropPosition}` : ''}`}
              onClick={() => !isEditing && onSelect(s.id)}
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
                </div>
                <div className="session-cwd">{basename(s.cwd) || s.tmuxName}</div>
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
