import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionMeta } from '../types'

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  run: () => void
}

interface Props {
  sessions: SessionMeta[]
  activeId: string | null
  promptHistory: Record<string, Array<{ text: string; ts: number }>>
  onClose: () => void
  onSelectSession: (id: string) => void
  actions: PaletteAction[]
  mode?: 'all' | 'sessions'
}

interface Item {
  key: string
  label: string
  hint?: string
  badge?: string
  run: () => void
}

export function CommandPalette({
  sessions,
  activeId,
  promptHistory,
  onClose,
  onSelectSession,
  actions,
  mode = 'all'
}: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const items = useMemo<Item[]>(() => {
    const sessionItems: Item[] = sessions.map((s, i) => ({
      key: `s:${s.id}`,
      label: s.name,
      hint: i < 9 ? `⌘${i + 1}` : undefined,
      badge: s.id === activeId ? 'active' : 'session',
      run: () => onSelectSession(s.id)
    }))
    const actionItems: Item[] = mode === 'sessions'
      ? []
      : actions.map((a) => ({
          key: `a:${a.id}`,
          label: a.label,
          hint: a.hint,
          badge: 'action',
          run: a.run
        }))
    const promptItems: Item[] =
      mode === 'sessions' || !activeId
        ? []
        : (promptHistory[activeId] ?? []).map((entry, i) => ({
            key: `p:${i}`,
            label: entry.text,
            badge: 'prompt',
            run: () =>
              window.dispatchEvent(new CustomEvent('pk:search', { detail: entry.text }))
          }))
    const all = [...sessionItems, ...actionItems, ...promptItems]
    if (!query.trim()) return all
    const q = query.toLowerCase()
    return all.filter((item) => fuzzyMatch(item.label.toLowerCase(), q))
  }, [sessions, activeId, actions, query, onSelectSession, mode, promptHistory])

  useEffect(() => {
    setCursor(0)
  }, [query])

  const select = (item: Item) => {
    item.run()
    onClose()
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="palette-input"
          placeholder={mode === 'sessions' ? 'Jump to a session…' : 'Jump to a session or run an action…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(items.length - 1, c + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(0, c - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const item = items[cursor]
              if (item) select(item)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <div className="palette-list">
          {items.length === 0 && <div className="palette-empty">no matches</div>}
          {items.map((item, i) => (
            <div
              key={item.key}
              className={`palette-item ${i === cursor ? 'cursor' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => select(item)}
            >
              {item.badge && <span className={`palette-badge ${item.badge}`}>{item.badge}</span>}
              <span className="palette-label">{item.label}</span>
              {item.hint && <span className="palette-hint">{item.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function fuzzyMatch(text: string, query: string): boolean {
  let qi = 0
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) qi++
  }
  return qi === query.length
}
