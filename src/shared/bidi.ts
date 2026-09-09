// Decides which xterm DOM rows the bidi observer flips to RTL.

export const HEBREW_CHAR_RE = /[֐-׿יִ-ﭏ]/

// Box-drawing (U+2500–U+257F) and block elements (U+2580–U+259F): the glyphs
// Claude Code uses for frames (╭ ─ ╮ │), table rules, and progress bars.
const BOX_OR_BLOCK_RE = /[─-▟]/

const SPACE_ONLY_RE = /^[  ]*$/

/**
 * One styling run of an xterm DOM row: its text and a background identity —
 * '' for the default background, otherwise any stable token (an xterm-bg-<n>
 * class number, an inline rgb() string). Only equality matters.
 */
export interface RowSpan {
  text: string
  bg: string
}

/**
 * True when a row should be rendered `direction: rtl`.
 *
 * A row containing Hebrew flips RTL — EXCEPT when the row is a positional
 * layout, where reversing the span order relocates UI regions:
 *
 * 1. Box-drawing / block glyphs (frames, tables, progress bars): border
 *    glyphs live in their own styling spans and would land mid-row —
 *    seen as stray │ bars flickering inside the text.
 *
 * 2. A leading/trailing space-only run painted with a background that
 *    DIFFERS from the text's own background: that is another pane sharing
 *    the terminal row (Claude Code's /diff split paints its panel with a
 *    bg-color run and no glyphs). Flipping such a row throws the panel's
 *    gray block across the screen. A highlight that covers the whole row
 *    in ONE background (a selected menu item, the user-prompt row) is not
 *    a pane boundary and still flips.
 *
 * Skipped rows stay LTR: the Hebrew inside still shapes RTL within its own
 * isolated span, it just aligns left like in a plain terminal.
 */
export function rowNeedsRtl(spans: readonly RowSpan[]): boolean {
  const text = spans.map((s) => s.text).join('')
  if (!HEBREW_CHAR_RE.test(text)) return false
  if (BOX_OR_BLOCK_RE.test(text)) return false

  // Find the glyph-bearing core of the row.
  let first = -1
  let last = -1
  for (let i = 0; i < spans.length; i++) {
    if (!SPACE_ONLY_RE.test(spans[i].text)) {
      if (first === -1) first = i
      last = i
    }
  }
  if (first === -1) return false // spaces only — nothing to flip

  // Backgrounds the text itself sits on are "native" to the row; so is the
  // default background. A space-only edge run painted with any OTHER
  // background is a foreign pane region → positional layout, don't flip.
  const nativeBgs = new Set<string>([''])
  for (let i = first; i <= last; i++) nativeBgs.add(spans[i].bg)
  for (let i = 0; i < first; i++) {
    if (!nativeBgs.has(spans[i].bg)) return false
  }
  for (let i = last + 1; i < spans.length; i++) {
    if (!nativeBgs.has(spans[i].bg)) return false
  }
  return true
}
