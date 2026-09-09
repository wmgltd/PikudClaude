// Decides when xterm's screen has drifted from the tmux pane it mirrors.
//
// tmux only resends cells it believes changed on the client. If xterm's grid
// loses content for any reason tmux did not see (a resize round-trip, a wipe
// mid-stream, a dropped chunk), the pane stays fully intact server-side while
// the terminal shows black until the pane app happens to repaint —
// historically, the user pressing a key. The renderer counts its non-empty
// rows, main counts the pane's, and this module says whether the gap is the
// black-screen shape rather than ordinary one-frame lag.

/** Below this many non-empty pane rows there is too little to judge. */
export const MIN_PANE_ROWS = 8

/** Consecutive desynced samples before a redraw is forced. */
export const DESYNC_STREAK_TO_ACT = 2

/** Number of lines in `text` that contain something other than whitespace. */
export function countNonEmptyLines(text: string): number {
  let n = 0
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) n++
  }
  return n
}

/**
 * True when the pane clearly has content that xterm is not showing: the pane
 * has at least MIN_PANE_ROWS non-empty rows and xterm shows fewer than half of
 * them. A one-frame lag (a few rows short) never trips this; a black screen
 * over a full pane (xterm holding only the input box and the tmux status
 * line — five to seven rows against forty) always does.
 */
export function isScreenDesynced(xtermNonEmpty: number, paneNonEmpty: number): boolean {
  if (paneNonEmpty < MIN_PANE_ROWS) return false
  return xtermNonEmpty * 2 < paneNonEmpty
}

/** What main reports back to the renderer after one screen-sync sample. */
export interface ScreenCheckResult {
  /** Non-empty rows in the tmux pane's visible screen; -1 when skipped. */
  paneNonEmpty: number
  desynced: boolean
  /** Consecutive desynced samples so far (0 when in sync). */
  streak: number
  /** Whether this sample forced a refresh-client. */
  forced: boolean
  skipped?: 'copy-mode'
}
