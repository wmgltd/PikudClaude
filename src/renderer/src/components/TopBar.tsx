import { useEffect, useState } from 'react'
import type { SessionMeta, SessionStatus } from '../types'
import { basename } from '../utils/path'
import { IS_MAC } from '../utils/platform'

interface Props {
  session: SessionMeta | null
  lastPrompt?: string | null
  lastPromptTs?: number | null
  status?: SessionStatus
  onClearPromptHistory?: () => void
  view: 'terminal' | 'dashboard'
  onToggleView: () => void
}

export function TopBar({
  session,
  lastPrompt,
  lastPromptTs,
  status,
  onClearPromptHistory,
  view,
  onToggleView
}: Props): JSX.Element {
  const [branch, setBranch] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30 * 1000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!menuPos) return
    const close = (): void => setMenuPos(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', close)
    }
  }, [menuPos])

  useEffect(() => {
    if (!session?.cwd) {
      setBranch(null)
      return
    }
    let cancelled = false
    window.api
      .getGitBranch(session.cwd)
      .then((b) => {
        if (!cancelled) setBranch(b)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [session?.id, session?.cwd])

  if (!session) {
    return (
      <div className="top-bar empty">
        <span>PikudClaude</span>
        <button
          type="button"
          className="top-bar-view-toggle"
          title={`Toggle dashboard view (${IS_MAC ? '⌘D' : 'Ctrl+Shift+D'})`}
          onClick={onToggleView}
        >
          {view === 'dashboard' ? '⊞ dashboard' : '⊟ terminal'}
        </button>
      </div>
    )
  }
  function isRtl(text: string): boolean {
    return /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(text)
  }
  const dir = basename(session.cwd) || session.cwd
  function formatRelative(ms: number): string {
    if (ms < 0 || !Number.isFinite(ms)) return ''
    const s = Math.floor(ms / 1000)
    if (s < 60) return 'just now'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  }

  return (
    <div className="top-bar">
      <span className="top-bar-name" style={{ borderColor: session.color }}>
        {session.name}
      </span>
      <span className="top-bar-sep">·</span>
      <span className="top-bar-cwd" title={session.cwd}>{dir}</span>
      {branch && (
        <>
          <span className="top-bar-sep">·</span>
          <span className="top-bar-branch">⎇ {branch}</span>
        </>
      )}
      <button
        type="button"
        className="top-bar-view-toggle"
        title="Toggle dashboard view (⌘D)"
        onClick={onToggleView}
      >
        {view === 'dashboard' ? '⊞' : '⊟'}
      </button>
      {lastPrompt && (
        <span className="top-bar-prompt-wrap">
          <button
            type="button"
            className={`top-bar-prompt ${status ? `status-${status}` : ''}`}
            dir={isRtl(lastPrompt) ? 'rtl' : 'ltr'}
            onClick={() =>
              window.dispatchEvent(new CustomEvent('pk:search', { detail: lastPrompt }))
            }
            onDoubleClick={(e) => {
              e.preventDefault()
              navigator.clipboard.writeText(lastPrompt).catch(() => undefined)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenuPos({ x: e.clientX, y: e.clientY })
            }}
          >
            <span className={`top-bar-prompt-dot status-${status ?? 'idle'}`} />
            {lastPrompt}
          </button>
          {lastPromptTs && lastPromptTs > 0 && (
            <span className="top-bar-prompt-age">{formatRelative(now - lastPromptTs)}</span>
          )}
          <span className="top-bar-prompt-tip" dir={isRtl(lastPrompt) ? 'rtl' : 'ltr'}>
            {lastPrompt}
            <br />
            <span className="top-bar-prompt-tip-hint">
              click: find in terminal · double-click: copy · right-click: more
            </span>
          </span>
          {menuPos && (
            <div
              className="top-bar-prompt-menu"
              style={{ left: menuPos.x, top: menuPos.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => {
                  setMenuPos(null)
                  window.dispatchEvent(new CustomEvent('pk:search', { detail: lastPrompt }))
                }}
              >
                Find in terminal
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuPos(null)
                  navigator.clipboard.writeText(lastPrompt).catch(() => undefined)
                }}
              >
                Copy
              </button>
              {onClearPromptHistory && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    setMenuPos(null)
                    onClearPromptHistory()
                  }}
                >
                  Clear history for this session
                </button>
              )}
            </div>
          )}
        </span>
      )}
    </div>
  )
}
