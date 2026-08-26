/**
 * Per-session resource reading, used by the sidebar to answer "which of these
 * can I close?".
 */
export interface SessionVitals {
  id: string
  /** Time since tmux last saw activity in the session. null when unknown. */
  idleMs: number | null
  /**
   * Resident memory of the session's whole process subtree, in MB. null when
   * it could not be measured. Understates heavily on a swapping machine — good
   * for ranking sessions, not for predicting how much RAM closing one frees.
   */
  rssMB: number | null
}

/** Sessions untouched for longer than this are worth a second look. */
export const STALE_SESSION_MS = 24 * 60 * 60 * 1000

/** Compact human form: "3d", "5h", "12m". */
export function formatIdle(ms: number): string {
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${Math.max(1, mins)}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Compact human form: "512MB", "1.4GB". */
export function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`
}
