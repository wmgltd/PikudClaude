import { useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  sessionId: string
  initialSearch?: string
  /** Which copy of `initialSearch` to jump to, 0-based, when the same text
   *  was sent more than once in the transcript. */
  initialSearchOccurrence?: number
  onClose: () => void
}

/**
 * Collapse every whitespace run to a single space, keeping a map from each
 * normalized offset back to its offset in the source. tmux hard-wraps the pane
 * at the terminal width, so a snippet the user sees as one line can be split
 * across several in the capture — matching on this projection makes the wrap
 * irrelevant, and the map lets us still highlight the original span.
 */
function normalize(src: string): { norm: string; map: number[] } {
  const chars: string[] = []
  const map: number[] = []
  let prevWasSpace = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const isSpace = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
    if (isSpace) {
      if (prevWasSpace) continue
      chars.push(' ')
      map.push(i)
      prevWasSpace = true
    } else {
      chars.push(ch)
      map.push(i)
      prevWasSpace = false
    }
  }
  return { norm: chars.join(''), map }
}

/**
 * Progressively shorter prefixes of the needle. Stops at 24 chars: below that
 * a "match" says almost nothing, and silently landing on an unrelated message
 * is worse than reporting no hit at all.
 */
function candidatesFor(needle: string): string[] {
  const out: string[] = []
  const push = (s: string): void => {
    const v = s.trim()
    if (v.length >= 24 && !out.includes(v)) out.push(v)
  }
  push(needle)
  push(needle.slice(0, 120))
  push(needle.slice(0, 60))
  const words = needle.split(' ')
  if (words.length >= 6) push(words.slice(0, 6).join(' '))
  push(needle.slice(0, 24))
  // Nothing cleared the floor (very short prompt) — use it verbatim rather
  // than giving up, since a short needle is at least the *whole* message.
  if (out.length === 0 && needle.trim()) out.push(needle.trim())
  return out
}

export function ScrollbackOverlay({
  sessionId,
  initialSearch,
  initialSearchOccurrence = 0,
  onClose
}: Props): JSX.Element {
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

  // Find where to highlight + scroll. Matching runs on the whitespace-collapsed
  // projection of both sides so tmux's hard wrap can't break a hit, and we
  // collect EVERY match for the longest candidate that lands — picking the
  // occurrence the bubble asked for. Taking `indexOf`'s first hit sent every
  // repeated prompt ("yes", "continue") to the top of the buffer.
  const hit = useMemo(() => {
    if (!text || !initialSearch) return null
    const needle = initialSearch.trim().replace(/\s+/g, ' ')
    if (!needle) return null
    const { norm, map } = normalize(text)

    for (const candidate of candidatesFor(needle)) {
      const starts: number[] = []
      let from = 0
      for (;;) {
        const at = norm.indexOf(candidate, from)
        if (at === -1) break
        starts.push(at)
        from = at + 1
      }
      if (starts.length === 0) continue
      // Fewer matches than the transcript had repeats (buffer is finite and
      // scrolled off) — fall back to the most recent one rather than a random
      // earlier hit.
      const nth = Math.min(initialSearchOccurrence, starts.length - 1)
      const pick = starts[nth]
      const start = map[pick]
      const end = map[Math.min(pick + candidate.length - 1, map.length - 1)] + 1
      return { start, end, nth, total: starts.length }
    }
    return null
  }, [text, initialSearch, initialSearchOccurrence])

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
            {initialSearch && hit && (
              <span className="scrollback-hint">
                {hit.total > 1
                  ? ` · jumped to match ${hit.nth + 1} of ${hit.total}`
                  : ' · jumped to match'}
              </span>
            )}
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
                {text.slice(0, hit.start)}
                <mark ref={markRef} className="scrollback-mark">
                  {text.slice(hit.start, hit.end)}
                </mark>
                {text.slice(hit.end)}
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
