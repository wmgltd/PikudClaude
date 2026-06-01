import { useEffect, useMemo, useState } from 'react'
import type { SessionMeta, SessionStatus } from '../types'
import { basename } from '../utils/path'

interface Props {
  sessions: SessionMeta[]
  statuses: Record<string, SessionStatus>
  promptHistory: Record<string, Array<{ text: string; ts: number }>>
  promptStats: Record<string, number[]>
  onFocus: (id: string) => void
}

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/

const STATUS_RANK: Record<SessionStatus, number> = {
  awaiting: 0,
  working: 1,
  idle: 2,
  detached: 3,
  shell: 4
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  awaiting: 'AWAITING',
  working: 'WORKING',
  idle: 'IDLE',
  detached: 'DETACHED',
  shell: 'SHELL'
}

export function Dashboard({
  sessions,
  statuses,
  promptHistory,
  promptStats,
  onFocus
}: Props): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15 * 1000)
    return () => clearInterval(t)
  }, [])

  const [branches, setBranches] = useState<Record<string, string | null>>({})
  useEffect(() => {
    let cancelled = false
    const fetchAll = async (): Promise<void> => {
      const next: Record<string, string | null> = {}
      await Promise.all(
        sessions.map(async (s) => {
          if (!s.cwd) {
            next[s.id] = null
            return
          }
          try {
            next[s.id] = await window.api.getGitBranch(s.cwd)
          } catch {
            next[s.id] = null
          }
        })
      )
      if (!cancelled) setBranches(next)
    }
    fetchAll()
    return () => {
      cancelled = true
    }
  }, [sessions])

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const sa = statuses[a.id] ?? 'idle'
      const sb = statuses[b.id] ?? 'idle'
      const r = STATUS_RANK[sa] - STATUS_RANK[sb]
      if (r !== 0) return r
      const ta = promptHistory[a.id]?.[0]?.ts ?? 0
      const tb = promptHistory[b.id]?.[0]?.ts ?? 0
      return tb - ta
    })
  }, [sessions, statuses, promptHistory])

  if (sessions.length === 0) {
    return (
      <div className="dashboard-empty">
        no sessions yet — hit <kbd>+</kbd> in the sidebar to start one
      </div>
    )
  }

  return (
    <div className="dashboard">
      {sortedSessions.map((s) => {
        const status = statuses[s.id] ?? 'idle'
        const promptEntry = promptHistory[s.id]?.[0]
        const ageMs = promptEntry?.ts ? now - promptEntry.ts : null
        return (
          <button
            type="button"
            key={s.id}
            className={`dashboard-card status-${status}`}
            onClick={() => onFocus(s.id)}
            style={{ borderTopColor: s.color }}
          >
            <div className="dashboard-card-header">
              <span className="dashboard-card-name">{s.name}</span>
              <span className={`dashboard-card-badge status-${status}`}>
                {STATUS_LABEL[status]}
              </span>
            </div>
            {promptEntry ? (
              <div className="dashboard-card-prompt" title={promptEntry.text}>
                <span className="dashboard-card-prompt-icon">↳</span>
                <span
                  className="dashboard-card-prompt-text"
                  dir={RTL_RE.test(promptEntry.text) ? 'rtl' : 'ltr'}
                >
                  {promptEntry.text}
                </span>
              </div>
            ) : (
              <div className="dashboard-card-prompt placeholder">
                <span className="dashboard-card-prompt-icon">↳</span>
                <span className="dashboard-card-prompt-text">no prompts tracked yet</span>
              </div>
            )}
            <div className="dashboard-card-stats">
              {ageMs !== null && (
                <span className="dashboard-card-stat">
                  <span className="dashboard-stat-label">last:</span> {formatRelative(ageMs)}
                </span>
              )}
              {(() => {
                const all = promptStats[s.id] ?? []
                const cutoff = now - 30 * 24 * 60 * 60 * 1000
                const last30 = all.reduce((n, t) => (t >= cutoff ? n + 1 : n), 0)
                return (
                  <span
                    className="dashboard-card-stat"
                    title={`${all.length} submissions all-time · ${last30} in the last 30 days`}
                  >
                    <span className="dashboard-stat-label">runs:</span>{' '}
                    {last30.toLocaleString('en')}
                    {all.length > last30 && (
                      <span className="dashboard-stat-muted">
                        {' / '}
                        {all.length.toLocaleString('en')}
                      </span>
                    )}
                  </span>
                )
              })()}
              {branches[s.id] && (
                <span className="dashboard-card-stat">
                  <span className="dashboard-stat-label">⎇</span> {branches[s.id]}
                </span>
              )}
            </div>
            <div className="dashboard-card-cwd" title={s.cwd}>
              {basename(s.cwd) || s.tmuxName}
            </div>
          </button>
        )
      })}
    </div>
  )
}

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
