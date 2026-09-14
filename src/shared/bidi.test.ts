import { describe, it, expect } from 'vitest'
import { HEBREW_CHAR_RE, isRtlText, rowNeedsRtl, type RowSpan } from './bidi'

const s = (text: string, bg = ''): RowSpan => ({ text, bg })
const plain = (text: string): RowSpan[] => [s(text)]

describe('rowNeedsRtl', () => {
  it('flips a plain Hebrew row', () => {
    expect(rowNeedsRtl(plain('שלום עולם'))).toBe(true)
  })

  it('flips a Hebrew row that mixes English and numbers', () => {
    expect(rowNeedsRtl(plain('הקובץ tmux.ts שונה ב-40 שורות'))).toBe(true)
  })

  it('flips a Hebrew row that starts with an LTR bullet', () => {
    // ⏺ (U+23FA) and ⎿ (U+23BF) are Claude Code's markers — not box drawing.
    expect(rowNeedsRtl(plain('⏺ מקמט את השינוי'))).toBe(true)
    expect(rowNeedsRtl(plain('⎿ נכתבו 60 שורות'))).toBe(true)
  })

  it('flips Hebrew split across styling spans with default backgrounds', () => {
    expect(rowNeedsRtl([s('⏺ '), s('הקובץ '), s('tmux.ts'), s(' שונה'), s('   ')])).toBe(true)
  })

  it('leaves English-only rows alone', () => {
    expect(rowNeedsRtl(plain('$ npm run build'))).toBe(false)
  })

  it('leaves empty and space-only rows alone', () => {
    expect(rowNeedsRtl([])).toBe(false)
    expect(rowNeedsRtl(plain(''))).toBe(false)
    expect(rowNeedsRtl([s('     ', 'p235')])).toBe(false)
  })

  it('never flips a framed row — borders would relocate mid-row', () => {
    expect(rowNeedsRtl(plain('│ האם לאשר את הפעולה? │'))).toBe(false)
    expect(rowNeedsRtl(plain('╭─ שאלה ─╮'))).toBe(false)
    expect(rowNeedsRtl(plain('התקדמות ▓▓▓░░░ 50%'))).toBe(false)
  })

  // Claude Code's /diff split paints its panel as a glyph-less background run
  // sharing the row with the chat. Flipping would throw the panel's gray
  // block across the screen (the "gray boxes" bug).
  it('never flips a chat row that carries a split-pane background tail', () => {
    expect(rowNeedsRtl([s('⏺ יש — שני צילומים חדשים.'), s(' '.repeat(57), 'p235')])).toBe(false)
  })

  it('never flips a highlighted prompt row followed by a split-pane tail', () => {
    expect(
      rowNeedsRtl([s('❯ שמתי 2 עכשיו', 'p237'), s(' '.repeat(56), 'p237'), s(' '.repeat(57), 'p235')])
    ).toBe(false)
  })

  it('never flips a row with a foreign background run on the leading edge', () => {
    expect(rowNeedsRtl([s(' '.repeat(57), 'p235'), s('⏺ טקסט עברי')])).toBe(false)
  })

  it('still flips a full-width highlighted prompt row (one background)', () => {
    expect(rowNeedsRtl([s('❯ שמתי 2 עכשיו', 'p237'), s(' '.repeat(113), 'p237')])).toBe(true)
  })

  it('still flips when trailing spaces are on the default background', () => {
    expect(rowNeedsRtl([s('⏺ טקסט עברי'), s(' '.repeat(100))])).toBe(true)
  })

  it('treats an RGB inline background as foreign too', () => {
    expect(rowNeedsRtl([s('שלום'), s(' '.repeat(30), 'rgb(40, 40, 40)')])).toBe(false)
  })
})

// Claude Code 2.1.270 /diff panel beside a Hebrew conversation, rows taken from
// a live Geektime-APP pane. The panel's own text made rule 2 treat its gray as
// native, so every such row flipped and threw its slice of the panel to the
// other side — a gray checkerboard over half the screen.
describe('split pane with content', () => {
  const panel = 'p235'
  it('keeps a chat row beside the panel header LTR', () => {
    expect(
      rowNeedsRtl([
        s('     הקטגוריה שתיקנתי בבילד 42. המסך הזה מיזג את השם של המתחם הקודם, ומכאן "AI'),
        s(' 7 files changed +131 -76                                    ✕', panel)
      ])
    ).toBe(false)
  })

  it('keeps a chat row beside a diff file line LTR (gap before the panel)', () => {
    expect(
      rowNeedsRtl([
        s('     שבר את מיקום הלחיצה, ובלי פיצול הרקע נמרח עד הקצה.   '),
        s(' src/components/ImageArticle/ImageArticle.tsx          +54 -55', panel)
      ])
    ).toBe(false)
  })

  it('keeps a chat row beside a red deletion line LTR (gutter + diff bg)', () => {
    expect(
      rowNeedsRtl([
        s('    להחליף אותה בתמונה ניטרלית עם לוגו גיקטיים, אבל זו החלטה עיצובית שלך.      '),
        s(' ', panel),
        s(' 166 -        color: staticFontColor ? staticFontColor : them', 'p52')
      ])
    ).toBe(false)
  })

  it('keeps a gray prompt row beside a green addition line LTR', () => {
    expect(
      rowNeedsRtl([
        s('❯ תכתוב את זה למעיין בסלאק', 'p237'),
        s('                                                    '),
        s(' ', panel),
        s('     +onding to a tap (the', 'p17')
      ])
    ).toBe(false)
  })

  it('keeps a gray prompt that fills the chat side up to the panel LTR (no gap)', () => {
    // Live row: cols 0–78 p237, col 79 p235 gutter, cols 80–140 p17.
    expect(
      rowNeedsRtl([
        s('❯ תכתוב את זה למעיין בסלאק' + ' '.repeat(53), 'p237'),
        s(' ', panel),
        s('      +onding to a tap (the' + ' '.repeat(35), 'p17')
      ])
    ).toBe(false)
  })

  it('keeps a short panel run LTR when blank cells separate it from the chat', () => {
    expect(rowNeedsRtl([s('   ההודעה אומרת שהתיקונים ייכנסו לבילד 46.     '), s(' +2', panel)])).toBe(false)
  })

  it('keeps a pane on the leading edge LTR too', () => {
    expect(rowNeedsRtl([s(' 172        a: {                                    ', panel), s('  שני דברים שכדאי לדעת')])).toBe(false)
  })

  it('still flips a gray prompt row with nothing beside it', () => {
    expect(rowNeedsRtl([s('❯ עדיין?', 'p237')])).toBe(true)
  })

  it('still flips a Hebrew row whose inline styled word hugs the end', () => {
    expect(rowNeedsRtl([s('הקובץ '), s('tmux.ts', 'p236')])).toBe(true)
  })
})

// Regression: a literal U+FB1D in HEBREW_CHAR_RE was rewritten by Unicode NFC
// into U+05D9 U+05B4, widening the class to U+05B4–U+FB4F. Every Claude Code
// row carrying ⏺ ✻ ❯ ⎿ → … was then treated as Hebrew and flipped RTL —
// mirrored English rows, and gray prompt/panel backgrounds thrown across the
// screen. These rows must stay LTR.
describe('Claude Code chrome without Hebrew', () => {
  const gray = 'p237'
  it.each([
    '✻ Brewed for 1m 11s · done 7:14 PM',
    '⏺ Committed the fix and pushed it',
    '  ⎿  Allowed by auto mode classifier',
    '  ⎿  “JWT is opaque to the app” → uds:/tmp/cc-socks/94334.sock',
    '› Message from @wabi-x-17: two short questions … (ctrl+o to expand)',
    '❯ ',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 10 agents',
    '日本語のテキスト'
  ])('leaves %j alone', (text) => {
    expect(rowNeedsRtl(plain(text))).toBe(false)
  })

  it('leaves an English prompt row on a gray background alone', () => {
    expect(rowNeedsRtl([s('❯ commit this and push it', gray)])).toBe(false)
  })

  it('still flips a Hebrew prompt row on a gray background', () => {
    expect(rowNeedsRtl([s('❯ עוד פעם נהרסים לי השיחות', gray)])).toBe(true)
  })
})

describe('HEBREW_CHAR_RE / RTL_SCRIPT_RE', () => {
  const symbols = ['→', '…', '✻', '❯', '⏺', '⎿', '⏵', '─', '│', '中', '·', 'a', ' ']
  it.each(symbols)('HEBREW_CHAR_RE does not match %j', (c) => {
    expect(HEBREW_CHAR_RE.test(c)).toBe(false)
  })
  it.each(symbols)('isRtlText does not match %j', (c) => {
    expect(isRtlText(c)).toBe(false)
  })
  it('matches Hebrew letters, points and presentation forms', () => {
    for (const c of ['\u05D0', '\u05EA', '\u05B4', '\uFB1D', '\uFB4F']) expect(HEBREW_CHAR_RE.test(c)).toBe(true)
  })
  it('isRtlText matches Hebrew and Arabic', () => {
    for (const c of ['\u05E9\u05DC\u05D5\u05DD', '\u0645\u0631\u062D\u0628\u0627', '\uFB1D', '\uFE70', '\uFEFC']) expect(isRtlText(c)).toBe(true)
  })
})
