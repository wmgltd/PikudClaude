import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isRtlText } from '../../../shared/bidi'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  text: string
  ts: number
  toolName?: string
}

interface Props {
  sessionId: string | null
  onClose: () => void
}

const COLLAPSE_LINES = 18
// The initial backlog is capped in the main process, but appends are unbounded:
// over a long session the list grew to thousands of bubbles, and because this
// panel renders every message (no virtualization) EVERY unrelated re-render —
// and status events alone reach ~124/minute — had to walk all of them. Keep a
// rolling window instead; the terminal itself is the full record.
const MAX_LIVE_MESSAGES = 600

/**
 * The needle we hand the scrollback overlay. The first line alone is far too
 * weak — "yes", "continue", "hey pikudclaude" all collapse onto each other —
 * so take the first few non-empty lines and let the overlay narrow down from
 * there. Whitespace is collapsed because tmux re-wraps long lines and the
 * overlay matches on the same normalized projection.
 */
function jumpSnippet(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}

export function ConversationPanel({ sessionId, onClose }: Props): JSX.Element | null {
  const [messages, setMessages] = useState<Message[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(true)
  // Long-running Claude sessions produce transcripts far too big to load whole
  // (100 MB+ is routine), so the watcher sends only the tail. Say so instead of
  // implying this is the entire conversation.
  const [truncated, setTruncated] = useState(false)
  const [filters, setFilters] = useState({ mine: true, replies: true, tools: false })
  const toggle = (k: keyof typeof filters): void => setFilters((f) => ({ ...f, [k]: !f[k] }))
  // Stable identity so the memoized bubbles below actually stay memoized — an
  // inline arrow here would be a fresh prop on every render and defeat it.
  const toggleExpanded = useCallback((id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const listRef = useRef<HTMLDivElement>(null)
  // phase: 'initial' = pin to bottom on every render (initial backlog loading,
  // including after a /clear reset). 'live' = only auto-scroll on new messages
  // if the user is already near the bottom.
  const phaseRef = useRef<'initial' | 'live'>('initial')
  const syncCompletedRef = useRef(false)
  const lastCountRef = useRef(0)

  useEffect(() => {
    if (!sessionId) return
    setMessages([])
    setSyncing(true)
    setTruncated(false)
    setExpanded(new Set())
    phaseRef.current = 'initial'
    syncCompletedRef.current = false
    lastCountRef.current = 0

    const unsub = window.api.onConversationEvent((evt) => {
      if (evt.type === 'initial') {
        setMessages(evt.messages)
        setTruncated(Boolean(evt.truncated))
      } else if (evt.type === 'append') {
        setMessages((prev) => {
          const next = [...prev, ...evt.messages]
          if (next.length <= MAX_LIVE_MESSAGES) return next
          setTruncated(true)
          return next.slice(-MAX_LIVE_MESSAGES)
        })
      } else if (evt.type === 'reset') {
        setMessages([])
        setTruncated(false)
        phaseRef.current = 'initial'
        lastCountRef.current = 0
      } else if (evt.type === 'sync_complete') {
        setSyncing(false)
        syncCompletedRef.current = true
      }
    })
    window.api.watchConversation(sessionId).catch(() => undefined)

    return () => {
      unsub()
      window.api.unwatchConversation().catch(() => undefined)
    }
  }, [sessionId])

  const visible = messages.filter((m) => {
    if (m.role === 'user') return filters.mine
    if (m.role === 'assistant') return filters.replies
    if (m.role === 'tool_use' || m.role === 'tool_result') return filters.tools
    return true
  })

  // How many earlier messages open with the same snippet. The scrollback holds
  // every repeat of "yes" / "continue" in the same order the transcript does,
  // so this ordinal is what lets the overlay land on the copy you clicked
  // instead of the first one in the buffer. Counted over ALL messages, not the
  // filtered view — the terminal shows everything regardless of the chips.
  const occurrenceById = useMemo(() => {
    const seen = new Map<string, number>()
    const out = new Map<string, number>()
    for (const m of messages) {
      const key = jumpSnippet(m.text)
      const n = seen.get(key) ?? 0
      out.set(m.id, n)
      seen.set(key, n + 1)
    }
    return out
  }, [messages])

  // Pin scroll to bottom for the entire initial-load phase (so even if events
  // come in batches, each render keeps us pinned). Once the backlog is fully
  // synced AND we've actually rendered content at the bottom, switch to the
  // "only scroll if user is near bottom" live behavior. Layout effect, not
  // regular effect, so the scroll happens before the browser paints — no
  // visible flash at the top.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || visible.length === 0) return

    if (phaseRef.current === 'initial') {
      el.scrollTop = el.scrollHeight
      lastCountRef.current = visible.length
      if (syncCompletedRef.current) {
        phaseRef.current = 'live'
      }
      return
    }

    if (visible.length <= lastCountRef.current) {
      lastCountRef.current = visible.length
      return
    }
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    lastCountRef.current = visible.length
    if (distFromBottom < 120) {
      el.scrollTop = el.scrollHeight
    }
  }, [visible])

  if (!sessionId) return null

  return (
    <aside className="conv-panel">
      <div className="conv-header">
        <span>Conversation</span>
        {syncing && <span className="conv-syncing">syncing…</span>}
        <span className="conv-count">{visible.length}</span>
        <div className="conv-filters">
          <button
            type="button"
            className={`conv-filter ${filters.mine ? 'on' : ''}`}
            onClick={() => toggle('mine')}
            title="Show your prompts"
          >
            Mine
          </button>
          <button
            type="button"
            className={`conv-filter ${filters.replies ? 'on' : ''}`}
            onClick={() => toggle('replies')}
            title="Show Claude's replies"
          >
            Replies
          </button>
          <button
            type="button"
            className={`conv-filter ${filters.tools ? 'on' : ''}`}
            onClick={() => toggle('tools')}
            title="Show tool calls and results"
          >
            Tools
          </button>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close (⌘J)">
          ×
        </button>
      </div>
      <div className="conv-list" ref={listRef}>
        {!syncing && visible.length === 0 && (
          <div className="conv-empty">no messages yet — start talking to Claude</div>
        )}
        {truncated && visible.length > 0 && (
          <div className="conv-truncated">
            showing the most recent part of this conversation — earlier messages are in
            the transcript but too large to load here
          </div>
        )}
        {visible.map((m) => (
          <ConvBubble
            key={m.id}
            msg={m}
            occurrence={occurrenceById.get(m.id) ?? 0}
            expanded={expanded.has(m.id)}
            onToggle={toggleExpanded}
          />
        ))}
      </div>
    </aside>
  )
}

interface BubbleProps {
  msg: Message
  occurrence: number
  expanded: boolean
  onToggle: (id: string) => void
}

// Memoized: App re-renders on every session-status event (measured at up to
// ~124/minute), and without this each one re-rendered every bubble in the list.
// All four props are stable across those renders — `msg` objects come straight
// out of state and `onToggle` is a useCallback.
const ConvBubble = memo(function ConvBubble({
  msg,
  occurrence,
  expanded,
  onToggle
}: BubbleProps): JSX.Element {
  const lines = msg.text.split('\n')
  const isLong = lines.length > COLLAPSE_LINES
  const visibleText = isLong && !expanded ? lines.slice(0, COLLAPSE_LINES).join('\n') : msg.text
  const rtl = isRtlText(msg.text)
  const [copied, setCopied] = useState(false)

  const onBubbleClick = (): void => {
    // Don't hijack the click if the user is selecting text in the bubble.
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim()) return
    const snippet = jumpSnippet(msg.text)
    if (!snippet) return
    window.dispatchEvent(
      new CustomEvent('pk:jump-to-text', { detail: { text: snippet, occurrence } })
    )
  }

  return (
    <div
      className={`conv-bubble role-${msg.role}`}
      role="button"
      tabIndex={0}
      onClick={onBubbleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onBubbleClick()
        }
      }}
      title="Click to jump to this in the terminal"
    >
      <div className="conv-bubble-meta">
        <span className="conv-role">{labelForRole(msg.role, msg.toolName)}</span>
        <span className="conv-time">{formatTime(msg.ts)}</span>
        <button
          type="button"
          className={`conv-copy ${copied ? 'copied' : ''}`}
          title="Copy message"
          onClick={(e) => {
            e.stopPropagation()
            navigator.clipboard
              .writeText(msg.text)
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              })
              .catch(() => undefined)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="conv-body" dir={rtl ? 'rtl' : 'ltr'}>
        {visibleText}
        {isLong && (
          <>
            {!expanded && '…'}
            <button
              type="button"
              className="conv-more"
              onClick={(e) => {
                e.stopPropagation()
                onToggle(msg.id)
              }}
            >
              {expanded ? 'show less' : `show ${lines.length - COLLAPSE_LINES} more lines`}
            </button>
          </>
        )}
      </div>
    </div>
  )
})

function labelForRole(role: Message['role'], toolName?: string): string {
  if (role === 'user') return 'you'
  if (role === 'assistant') return 'claude'
  if (role === 'tool_use') return toolName ? `tool · ${toolName}` : 'tool'
  if (role === 'tool_result') return 'tool result'
  return role
}

function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
