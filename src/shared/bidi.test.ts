import { describe, it, expect } from 'vitest'
import { rowNeedsRtl, type RowSpan } from './bidi'

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
