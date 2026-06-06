import { useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  sessionId: string
  initialSearch?: string
  onClose: () => void
}

export function ScrollbackOverlay({ sessionId, initialSearch, onClose }: Props): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const markRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .captureScrollback(sessionId)
      .then((snap) => {
        if (!cancelled) setText(snap)
      })
      .catch(() => {
        if (!cancelled) setText('')
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Find where to highlight + scroll. Try the snippet as-is, then a few
  // shorter variants — xterm/tmux capture may not preserve the exact line
  // wrapping the bubble came from.
  const hit = useMemo(() => {
    if (!text || !initialSearch) return null
    const trimmed = initialSearch.trim()
    if (!trimmed) return null
    const candidates: string[] = []
    const push = (s: string): void => {
      const v = s.trim()
      if (v.length >= 4 && !candidates.includes(v)) candidates.push(v)
    }
    push(trimmed.slice(0, 60))
    push(trimmed.slice(0, 30))
    const words = trimmed.split(/\s+/)
    if (words.length >= 3) push(words.slice(0, 3).join(' '))
    push(trimmed.slice(0, 12))
    for (const c of candidates) {
      const idx = text.indexOf(c)
      if (idx !== -1) return { idx, match: c }
    }
    return null
  }, [text, initialSearch])

  // After paint: scroll to the highlight if found, otherwise to the bottom
  // (the live screen), matching the original overlay behavior.
  useEffect(() => {
    if (text === null) return
    if (hit && markRef.current) {
      markRef.current.scrollIntoView({ block: 'center' })
      return
    }
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [text, hit])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog scrollback-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="scrollback-header">
          <span>
            Scrollback — drag to select, ⌘C to copy
            {initialSearch && hit && <span className="scrollback-hint"> · jumped to match</span>}
            {initialSearch && !hit && text !== null && (
              <span className="scrollback-hint"> · not in scrollback</span>
            )}
          </span>
          <button
            type="button"
            className="scrollback-close"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {text === null ? (
          <div className="scrollback-loading">capturing scrollback…</div>
        ) : (
          <pre ref={preRef} className="scrollback-text">
            {hit ? (
              <>
                {text.slice(0, hit.idx)}
                <mark ref={markRef} className="scrollback-mark">
                  {hit.match}
                </mark>
                {text.slice(hit.idx + hit.match.length)}
              </>
            ) : (
              text || '(scrollback is empty)'
            )}
          </pre>
        )}
      </div>
    </div>
  )
}
