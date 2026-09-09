import { describe, it, expect } from 'vitest'
import { rowNeedsRtl } from './bidi'

describe('rowNeedsRtl', () => {
  it('flips a plain Hebrew row', () => {
    expect(rowNeedsRtl('שלום עולם')).toBe(true)
  })

  it('flips a Hebrew row that mixes English and numbers', () => {
    expect(rowNeedsRtl('הקובץ tmux.ts שונה ב-40 שורות')).toBe(true)
  })

  it('flips a Hebrew row that starts with an LTR bullet', () => {
    // ⏺ (U+23FA) and ⎿ (U+23BF) are Claude Code's markers — not box drawing.
    expect(rowNeedsRtl('⏺ מקמט את השינוי')).toBe(true)
    expect(rowNeedsRtl('⎿ נכתבו 60 שורות')).toBe(true)
  })

  it('leaves English-only rows alone', () => {
    expect(rowNeedsRtl('$ npm run build')).toBe(false)
  })

  it('leaves empty rows alone', () => {
    expect(rowNeedsRtl('')).toBe(false)
  })

  it('never flips a framed row — borders would relocate mid-row', () => {
    expect(rowNeedsRtl('│ האם לאשר את הפעולה? │')).toBe(false)
    expect(rowNeedsRtl('╭─ שאלה ─╮')).toBe(false)
  })

  it('never flips horizontal rules or box-only rows', () => {
    expect(rowNeedsRtl('─'.repeat(80))).toBe(false)
    expect(rowNeedsRtl('╰' + '─'.repeat(20) + '╯')).toBe(false)
  })

  it('never flips a Hebrew row holding a table or progress bar', () => {
    expect(rowNeedsRtl('שם │ ערך')).toBe(false)
    expect(rowNeedsRtl('התקדמות ▓▓▓░░░ 50%')).toBe(false)
  })
})
