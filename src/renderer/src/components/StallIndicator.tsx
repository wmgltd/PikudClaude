import { useEffect, useRef, useState } from 'react'

interface MemoryPressure {
  swapUsedMB: number
  swapTotalMB: number
  ramTotalMB: number
  critical: boolean
}

// The whole problem with telling the user "the UI is frozen" is that when it is
// frozen, nothing that would draw the message can run: no React render, no
// timer, no event handler. The one thing that keeps going is a compositor-driven
// animation — Chromium runs opacity animations off the main thread precisely so
// they survive main-thread jank.
//
// So the banner is always mounted, and an opacity keyframe holds it at 0 for
// STALL_VISIBLE_MS before fading in. A heartbeat rewinds that animation several
// times a second. While the main thread is alive the banner can never reach the
// visible part of the curve; the moment the thread blocks, the heartbeat stops,
// the animation runs on without it, and the banner appears by itself.
//
// Limit worth knowing: if the GPU/compositor process is ALSO starved — which is
// what a Mac deep in swap does — even this can be late. It degrades gracefully
// (the banner shows as soon as a frame gets drawn) rather than lying.
const HEARTBEAT_MS = 200
const STALL_VISIBLE_MS = 1200
const FADE_MS = 400
// Tail past the fade keeps opacity pinned at 1 for a long stall instead of the
// animation ending and the fill snapping anywhere unexpected.
const ANIM_MS = STALL_VISIBLE_MS + FADE_MS + 20_000
// After the fact, only report gaps a human would actually have felt.
const STALL_REPORT_MS = 700
// Above this a "gap" is the machine having been asleep, not the UI hanging.
const MAX_PLAUSIBLE_STALL_MS = 60_000
const TOAST_MS = 6000

function describePressure(p: MemoryPressure | null): string | null {
  if (!p || !p.critical) return null
  const gb = (mb: number): string => (mb / 1024).toFixed(0)
  return `your Mac is out of memory — ${gb(p.swapUsedMB)} GB of ${gb(
    p.swapTotalMB
  )} GB swap in use on ${gb(p.ramTotalMB)} GB of RAM. Every app on the machine is stalling, not just PikudClaude.`
}

export function StallIndicator(): JSX.Element {
  const bannerRef = useRef<HTMLDivElement>(null)
  const [pressure, setPressure] = useState<MemoryPressure | null>(null)
  const [lastStallMs, setLastStallMs] = useState<number | null>(null)

  // Keep the reason text current while the thread is healthy, so that when the
  // banner is revealed mid-freeze it already reads correctly — nothing can
  // update it at that point.
  useEffect(() => {
    window.api
      .getMemoryPressure()
      .then((p) => setPressure(p))
      .catch(() => undefined)
    return window.api.onMemoryPressure((p) => setPressure(p))
  }, [])

  useEffect(() => {
    const el = bannerRef.current
    if (!el || typeof el.animate !== 'function') return

    const anim = el.animate(
      [
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: STALL_VISIBLE_MS / ANIM_MS },
        { opacity: 1, offset: (STALL_VISIBLE_MS + FADE_MS) / ANIM_MS },
        { opacity: 1, offset: 1 }
      ],
      { duration: ANIM_MS, easing: 'linear', fill: 'forwards' }
    )

    let last = performance.now()
    const rewind = (): void => {
      anim.currentTime = 0
      // A finished animation stays finished until it is seeked AND replayed.
      if (anim.playState !== 'running') anim.play()
    }

    const beat = window.setInterval(() => {
      const now = performance.now()
      const blockedFor = now - last - HEARTBEAT_MS
      last = now
      rewind()
      if (blockedFor >= STALL_REPORT_MS && blockedFor < MAX_PLAUSIBLE_STALL_MS) {
        setLastStallMs(blockedFor)
      }
    }, HEARTBEAT_MS)

    // A hidden or occluded window has its timers throttled to a crawl by
    // Chromium, which would look exactly like a freeze. Stand down while
    // hidden and re-arm on the way back.
    const onVisibility = (): void => {
      last = performance.now()
      if (document.hidden) {
        anim.pause()
        anim.currentTime = 0
      } else {
        rewind()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearInterval(beat)
      document.removeEventListener('visibilitychange', onVisibility)
      anim.cancel()
    }
  }, [])

  useEffect(() => {
    if (lastStallMs === null) return
    const t = setTimeout(() => setLastStallMs(null), TOAST_MS)
    return () => clearTimeout(t)
  }, [lastStallMs])

  const reason = describePressure(pressure)

  return (
    <>
      <div ref={bannerRef} className="stall-banner" role="status" aria-live="polite">
        <span className="stall-pulse" />
        <span className="stall-text">
          <strong>Interface frozen</strong> — what you type is queued and will appear when
          it recovers.
          {reason && <span className="stall-reason">{reason}</span>}
        </span>
      </div>
      {lastStallMs !== null && (
        <div className="stall-toast">
          interface was frozen for {(lastStallMs / 1000).toFixed(1)}s
          {pressure?.critical && ' · machine is out of memory'}
        </div>
      )}
    </>
  )
}
