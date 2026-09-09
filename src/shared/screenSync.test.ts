import { describe, expect, it } from 'vitest'
import { countNonEmptyLines, isScreenDesynced, MIN_PANE_ROWS } from './screenSync'

describe('countNonEmptyLines', () => {
  it('ignores blank and whitespace-only lines', () => {
    expect(countNonEmptyLines('')).toBe(0)
    expect(countNonEmptyLines('\n\n   \n\t\n')).toBe(0)
    expect(countNonEmptyLines('a\n\n b \n\n')).toBe(2)
  })

  it('counts a 46-row pane the way tmux capture-pane emits it', () => {
    const rows = Array.from({ length: 46 }, (_, i) => (i % 3 === 0 ? '' : `line ${i}`))
    expect(countNonEmptyLines(rows.join('\n') + '\n')).toBe(30)
  })
})

describe('isScreenDesynced', () => {
  it('flags a black screen over a full pane', () => {
    // xterm holds only the input box + separators + tmux status line.
    expect(isScreenDesynced(5, 40)).toBe(true)
    expect(isScreenDesynced(7, 40)).toBe(true)
    expect(isScreenDesynced(0, 12)).toBe(true)
  })

  it('does not flag one-frame lag', () => {
    expect(isScreenDesynced(38, 40)).toBe(false)
    expect(isScreenDesynced(21, 40)).toBe(false)
  })

  it('does not judge a nearly empty pane', () => {
    expect(isScreenDesynced(0, MIN_PANE_ROWS - 1)).toBe(false)
    expect(isScreenDesynced(0, 0)).toBe(false)
  })

  it('never flags xterm showing at least as much as the pane', () => {
    expect(isScreenDesynced(40, 40)).toBe(false)
    expect(isScreenDesynced(41, 40)).toBe(false)
  })
})
