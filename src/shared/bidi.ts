// Decides which xterm DOM rows the bidi observer flips to RTL.

export const HEBREW_CHAR_RE = /[֐-׿יִ-ﭏ]/

// Box-drawing (U+2500–U+257F) and block elements (U+2580–U+259F): the glyphs
// Claude Code uses for frames (╭ ─ ╮ │), table rules, and progress bars.
const BOX_OR_BLOCK_RE = /[─-▟]/

/**
 * True when a row should be rendered `direction: rtl`.
 *
 * A row containing Hebrew flips RTL — EXCEPT when it also carries box-drawing
 * or block glyphs. Those rows are positional UI (a dialog frame, a table, a
 * progress bar): under `direction: rtl` the row lays its isolated spans out
 * right-to-left, and since border glyphs sit in their own styling spans they
 * relocate into the middle of the row — seen as stray │ bars flickering inside
 * the text while Claude Code redraws. Keeping frame rows LTR preserves the
 * frame; the Hebrew inside still shapes RTL within its own span, it just
 * aligns left like in a plain terminal.
 */
export function rowNeedsRtl(text: string): boolean {
  return HEBREW_CHAR_RE.test(text) && !BOX_OR_BLOCK_RE.test(text)
}
