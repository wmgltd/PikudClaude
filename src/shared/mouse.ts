/**
 * Wheel/mouse wire-format helpers.
 *
 * Pure and dependency-free on purpose: every bug this file exists to prevent
 * was a one-line encoding mistake that no amount of manual clicking caught, and
 * keeping it importable without Electron/xterm is what makes it testable.
 */

/** X10 wheel button codes, before the +32 offset the encoding applies. */
export const WHEEL_UP = 64
export const WHEEL_DOWN = 65

/** X10 cannot express a coordinate past this. */
export const X10_MAX_CELL = 223

/**
 * Build one X10 mouse report: ESC [ M <button+32> <col+32> <row+32>.
 *
 * The returned string has one code unit per wire byte, every one of them
 * <= 255. It MUST be written with latin1 byte semantics — handing it to
 * node-pty as a normal string encodes it as UTF-8, and every coordinate past
 * column 95 then goes out as two bytes. tmux fails to parse that, drops the
 * wheel event entirely, and delivers the leftover byte to the pane as a
 * literal character (column 100 typed "4", column 150 typed ">").
 */
export function encodeX10Wheel(button: number, col: number, row: number): string {
  const clamp = (n: number): number => Math.min(X10_MAX_CELL, Math.max(1, Math.trunc(n) || 1))
  return (
    '\x1b[M' +
    String.fromCharCode(button + 32) +
    String.fromCharCode(clamp(col) + 32) +
    String.fromCharCode(clamp(row) + 32)
  )
}

/**
 * DECSET/DECRST private modes that turn terminal mouse reporting on or off.
 * We swallow all of them so xterm never enters mouse mode and a drag stays
 * xterm-native text selection.
 */
export const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016])

/**
 * True when a CSI ? … h/l sequence sets ONLY mouse modes, i.e. it is safe to
 * consume. A sequence that also carries an unrelated mode (alt-screen, cursor
 * visibility) must fall through to xterm's own handler untouched.
 */
export function isAllMouseModes(params: (number | number[])[]): boolean {
  return (
    params.length > 0 &&
    params.every((p) => MOUSE_MODES.has(Array.isArray(p) ? p[0] : p))
  )
}

const MOUSE_TRACKING_RE = /\x1b\[\?(?:9|1000|1001|1002|1003|1004|1005|1006|1015|1016)[hl]/g

/**
 * Cheap first pass that drops whole mouse-tracking DECSETs from a PTY chunk.
 * Only catches sequences that arrive intact — a chunk boundary landing inside
 * one defeats it, which is why the xterm parser handler is the real guarantee.
 */
export function stripMouseTracking(data: string): string {
  return data.replace(MOUSE_TRACKING_RE, '')
}
