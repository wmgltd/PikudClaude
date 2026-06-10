import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/
const COLLAPSE_LINES = 3

export function ConversationPanel({ sessionId, onClose }: Props): JSX.Element | null {
  const [messages, setMessages] = useState<Message[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(true)
  const [showTools, setShowTools] = useState(false)
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
    setExpanded(new Set())
    phaseRef.current = 'initial'
    syncCompletedRef.current = false
    lastCountRef.current = 0

    const unsub = window.api.onConversationEvent((evt) => {
      if (evt.type === 'initial') {
        setMessages(evt.messages)
      } else if (evt.type === 'append') {
        setMessages((prev) => [...prev, ...evt.messages])
      } else if (evt.type === 'reset') {
        setMessages([])
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

  const visible = showTools
    ? messages
    : messages.filter((m) => m.role === 'user' || m.role === 'assistant')

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
        <button
          type="button"
          className={`conv-tools-toggle ${showTools ? 'on' : ''}`}
          onClick={() => setShowTools((v) => !v)}
          title={showTools ? 'Hide tool calls' : 'Show tool calls'}
        >
          tools
        </button>
        <button className="icon-btn" onClick={onClose} title="Close (⌘J)">
          ×
        </button>
      </div>
      <div className="conv-list" ref={listRef}>
        {!syncing && visible.length === 0 && (
          <div className="conv-empty">no messages yet — start talking to Claude</div>
        )}
        {visible.map((m) => (
          <ConvBubble
            key={m.id}
            msg={m}
            expanded={expanded.has(m.id)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev)
                if (next.has(m.id)) next.delete(m.id)
                else next.add(m.id)
                return next
              })
            }
          />
        ))}
      </div>
    </aside>
  )
}

interface BubbleProps {
  msg: Message
  expanded: boolean
  onToggle: () => void
}

function ConvBubble({ msg, expanded, onToggle }: BubbleProps): JSX.Element {
  const lines = msg.text.split('\n')
  const isLong = lines.length > COLLAPSE_LINES
  const visibleText = isLong && !expanded ? lines.slice(0, COLLAPSE_LINES).join('\n') : msg.text
  const rtl = RTL_RE.test(msg.text)
  const [copied, setCopied] = useState(false)

  const onBubbleClick = (): void => {
    // Don't hijack the click if the user is selecting text in the bubble.
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim()) return
    const firstLine = lines.find((l) => l.trim()) ?? msg.text
    const snippet = firstLine.trim()
    if (!snippet) return
    window.dispatchEvent(new CustomEvent('pk:jump-to-text', { detail: snippet }))
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
                onToggle()
              }}
            >
              {expanded ? 'show less' : `show ${lines.length - COLLAPSE_LINES} more lines`}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

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
