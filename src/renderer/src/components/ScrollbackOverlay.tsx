import { useEffect, useRef, useState } from 'react'

interface Props {
  sessionId: string
  onClose: () => void
}

export function ScrollbackOverlay({ sessionId, onClose }: Props): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)

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

  // Land at the bottom — the live screen — once content is in.
  useEffect(() => {
    if (text !== null && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [text])

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
          <span>Scrollback — drag to select, ⌘C to copy</span>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>
        {text === null ? (
          <div className="scrollback-loading">capturing scrollback…</div>
        ) : (
          <pre ref={preRef} className="scrollback-text">
            {text || '(scrollback is empty)'}
          </pre>
        )}
      </div>
    </div>
  )
}
