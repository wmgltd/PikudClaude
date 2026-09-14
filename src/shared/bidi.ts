// Decides which xterm DOM rows the bidi observer flips to RTL.

// Every range below is written with \u escapes, never literal characters.
// A literal U+FB1D (HEBREW LETTER YOD WITH HIRIQ) is a composition exclusion:
// Unicode NFC rewrites it as U+05D9 U+05B4, which silently turned the class
// [\u0590-\u05FF\uFB1D-\uFB4F] into [\u0590-\u05FF\u05D9\u05B4-\uFB4F] — a range
// spanning arrows, symbols, box drawing and CJK. Every Claude Code row with
// ⏺ ✻ ❯ ⎿ → … then counted as Hebrew and flipped RTL, throwing gray prompt
// and panel backgrounds across the screen. Escapes survive any editor or tool
// that normalizes text; unicodeSafety.test.ts guards the rest of src/.

/** Hebrew letters, points and presentation forms. */
export const HEBREW_CHAR_RE = /[\u0590-\u05FF\uFB1D-\uFB4F]/

/**
 * Any right-to-left script: Hebrew, Arabic, Syriac, Thaana, NKo and friends
 * (U+0590–U+08FF), plus Hebrew and Arabic presentation forms. Used to pick
 * `dir` for short text snippets (prompt previews, conversation bubbles).
 */
export const RTL_SCRIPT_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/

export function isRtlText(text: string): boolean {
  return RTL_SCRIPT_RE.test(text)
}

// Box-drawing (U+2500–U+257F) and block elements (U+2580–U+259F): the glyphs
// Claude Code uses for frames (╭ ─ ╮ │), table rules, and progress bars.
const BOX_OR_BLOCK_RE = /[\u2500-\u259F]/

const SPACE_ONLY_RE = /^[ \u00A0]*$/

/**
 * A background-painted run at a row's edge at least this wide is a pane, not
 * inline styling. Claude Code's /diff panel is ~60 cells; nothing inline in a
 * Hebrew row carries a background at all (surveyed across every session).
 */
const MIN_PANE_CELLS = 12

/** Blank default-background cells that separate a pane from the chat. */
const MIN_PANE_GAP = 2

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
 * 3. A pane WITH content at either edge: a run of background-painted spans
 *    holding its own glyphs, next to cells on the default background —
 *    Claude Code's /diff panel beside the conversation ("7 files changed",
 *    diff lines on red/green). Rule 2 misses it because the panel's text
 *    makes its background "native". The run counts as a pane when it is at
 *    least MIN_PANE_CELLS wide or sits MIN_PANE_GAP blank cells away from the
 *    rest of the row. Also a layout: two painted regions, each at least
 *    MIN_PANE_CELLS wide, on different backgrounds — a gray prompt filling
 *    the chat side right up to the panel, with no default cell between. A
 *    single background covering the whole row is a highlight and still flips.
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

  if (isEdgePane(spans, false) || isEdgePane(spans, true)) return false
  if (hasTwoWidePaintedRegions(spans)) return false
  return true
}

/** Rule 3, gapless case: two wide painted regions on different backgrounds. */
function hasTwoWidePaintedRegions(spans: readonly RowSpan[]): boolean {
  const wideBgs = new Set<string>()
  let i = 0
  while (i < spans.length) {
    const bg = spans[i].bg
    let width = 0
    while (i < spans.length && spans[i].bg === bg) {
      width += [...spans[i].text].length
      i++
    }
    if (bg !== '' && width >= MIN_PANE_CELLS) wideBgs.add(bg)
  }
  return wideBgs.size >= 2
}

/**
 * Rule 3: does a pane hug the row's leading (fromEnd=false) or trailing
 * (fromEnd=true) edge? Walks inward over background-painted spans, then counts
 * the blank default-background cells right next to that run.
 */
function isEdgePane(spans: readonly RowSpan[], fromEnd: boolean): boolean {
  const at = (k: number): RowSpan => spans[fromEnd ? spans.length - 1 - k : k]
  let k = 0
  let width = 0
  while (k < spans.length && at(k).bg !== '') {
    width += [...at(k).text].length
    k++
  }
  // No painted run at this edge, or the paint covers the whole row.
  if (k === 0 || k === spans.length) return false
  if (width >= MIN_PANE_CELLS) return true
  let gap = 0
  for (let i = k; i < spans.length && at(i).bg === ''; i++) {
    const chars = [...at(i).text]
    if (!fromEnd) chars.reverse()
    // Read away from the pane: trailing chars of the span when the pane is
    // to its right (fromEnd), leading chars when the pane is to its left.
    let run = 0
    for (let c = chars.length - 1; c >= 0 && (chars[c] === ' ' || chars[c] === '\u00A0'); c--) run++
    gap += run
    if (run < chars.length) break
  }
  return gap >= MIN_PANE_GAP
}
