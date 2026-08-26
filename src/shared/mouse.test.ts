import { describe, expect, it } from 'vitest'
import {
  encodeX10Wheel,
  isAllMouseModes,
  stripMouseTracking,
  WHEEL_DOWN,
  WHEEL_UP,
  X10_MAX_CELL
} from './mouse'

/** The bytes that actually reach tmux, given how the main process writes them. */
const wireBytes = (seq: string): number[] => Array.from(Buffer.from(seq, 'latin1'))
/** What WOULD have gone out if the sequence were written as a plain JS string. */
const utf8Bytes = (seq: string): number[] => Array.from(Buffer.from(seq, 'utf8'))

describe('encodeX10Wheel', () => {
  it('encodes button and coordinates with the +32 offset', () => {
    expect(wireBytes(encodeX10Wheel(WHEEL_UP, 1, 1))).toEqual([0x1b, 0x5b, 0x4d, 96, 33, 33])
    expect(wireBytes(encodeX10Wheel(WHEEL_DOWN, 1, 1))).toEqual([0x1b, 0x5b, 0x4d, 97, 33, 33])
  })

  it('always produces exactly 6 bytes on the wire, at any column', () => {
    // This is the regression. Column >= 96 pushes the coordinate byte past
    // 0x7F; as UTF-8 that becomes two bytes, tmux mis-parses the report, and
    // the leftover byte is typed into the pane as a literal character.
    for (const col of [1, 30, 63, 95, 96, 100, 150, 223]) {
      expect(wireBytes(encodeX10Wheel(WHEEL_UP, col, 20))).toHaveLength(6)
    }
  })

  it('would have been corrupted by UTF-8 encoding past column 95', () => {
    // Guards the *reason* the latin1 write path exists, so nobody "simplifies"
    // writeSessionBytes back into writeSession.
    expect(utf8Bytes(encodeX10Wheel(WHEEL_UP, 95, 20))).toHaveLength(6)
    expect(utf8Bytes(encodeX10Wheel(WHEEL_UP, 96, 20))).toHaveLength(7)
    expect(utf8Bytes(encodeX10Wheel(WHEEL_UP, 150, 20))).toHaveLength(7)
  })

  it('keeps every code unit within a single byte', () => {
    for (const col of [1, 96, 150, 223, 999]) {
      for (const ch of encodeX10Wheel(WHEEL_UP, col, col)) {
        expect(ch.charCodeAt(0)).toBeLessThanOrEqual(255)
      }
    }
  })

  it('clamps out-of-range cells instead of emitting garbage', () => {
    // bytes 0-2 are ESC [ M, byte 3 is the button; the coordinates follow.
    expect(wireBytes(encodeX10Wheel(WHEEL_UP, 9999, 9999)).slice(4)).toEqual([
      X10_MAX_CELL + 32,
      X10_MAX_CELL + 32
    ])
    expect(wireBytes(encodeX10Wheel(WHEEL_UP, 0, -5)).slice(4)).toEqual([33, 33])
  })
})

describe('isAllMouseModes', () => {
  it('claims the mouse-reporting modes', () => {
    for (const m of [9, 1000, 1002, 1003, 1006, 1015, 1016]) {
      expect(isAllMouseModes([m])).toBe(true)
    }
  })

  it('leaves unrelated private modes alone', () => {
    // 1049 is the alt-screen switch — swallowing it would break Claude's TUI.
    expect(isAllMouseModes([1049])).toBe(false)
    expect(isAllMouseModes([25])).toBe(false)
    expect(isAllMouseModes([2004])).toBe(false)
  })

  it('only claims multi-param sequences when EVERY param is a mouse mode', () => {
    expect(isAllMouseModes([1002, 1006])).toBe(true)
    expect(isAllMouseModes([1002, 1049])).toBe(false)
  })

  it('ignores an empty param list', () => {
    expect(isAllMouseModes([])).toBe(false)
  })

  it('reads sub-parameter arrays by their first value', () => {
    expect(isAllMouseModes([[1006, 1]])).toBe(true)
    expect(isAllMouseModes([[1049, 1]])).toBe(false)
  })
})

describe('stripMouseTracking', () => {
  it('removes intact mouse DECSETs and nothing else', () => {
    expect(stripMouseTracking('a\x1b[?1000h\x1b[?1006hb')).toBe('ab')
    expect(stripMouseTracking('\x1b[?1049h\x1b[2J')).toBe('\x1b[?1049h\x1b[2J')
  })

  it('cannot catch a sequence split across chunks — which is why the parser handler exists', () => {
    const whole = '\x1b[?1000h'
    const head = whole.slice(0, 5)
    const tail = whole.slice(5)
    expect(stripMouseTracking(whole)).toBe('')
    expect(stripMouseTracking(head) + stripMouseTracking(tail)).toBe(whole)
  })
})
