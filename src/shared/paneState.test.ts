import { describe, expect, it } from 'vitest'
import { detectAwaiting, isShellCommand, pickRotation } from './paneState'

describe('isShellCommand', () => {
  it('recognises shells, including login forms', () => {
    for (const c of ['bash', 'zsh', '-zsh', ' fish ', 'sh']) {
      expect(isShellCommand(c)).toBe(true)
    }
    expect(isShellCommand('')).toBe(true)
  })

  it('treats Claude Code as an app', () => {
    // Claude reports its version string as the command name.
    for (const c of ['2.1.228', '2.1.222', 'claude', 'node', 'vim']) {
      expect(isShellCommand(c)).toBe(false)
    }
  })
})

describe('detectAwaiting', () => {
  it('fires on Claude\'s numbered-choice prompt', () => {
    expect(
      detectAwaiting(['Do you want to proceed?', '❯ 1. Yes', '  2. No', ''].join('\n'))
    ).toBe(true)
  })

  it('does not fire on an ordinary numbered list', () => {
    // No pointer glyph — this is just output, not a prompt.
    expect(detectAwaiting(['Steps:', '  1. build', '  2. test'].join('\n'))).toBe(false)
  })

  it('does not fire on a pointer with no alternatives', () => {
    expect(detectAwaiting('❯ 1. Yes').valueOf()).toBe(false)
  })

  it('only looks at the last 30 lines', () => {
    const stale = ['❯ 1. Yes', '  2. No']
    const since = Array.from({ length: 40 }, (_, i) => `output line ${i}`)
    expect(detectAwaiting([...stale, ...since].join('\n'))).toBe(false)
  })
})

describe('pickRotation', () => {
  it('takes the requested count from the cursor', () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    expect(pickRotation(items, 0, 2)).toEqual({ picked: ['a', 'b'], nextCursor: 2 })
    expect(pickRotation(items, 2, 2)).toEqual({ picked: ['c', 'd'], nextCursor: 4 })
  })

  it('wraps around the end', () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    expect(pickRotation(items, 4, 3)).toEqual({ picked: ['e', 'a', 'b'], nextCursor: 2 })
  })

  it('never starves an item — the property the awaiting badge depends on', () => {
    // 17 background sessions, 4 probes per tick: everything must be covered
    // well inside a handful of ticks, or a session could sit stale forever.
    const items = Array.from({ length: 17 }, (_, i) => `s${i}`)
    const seen = new Set<string>()
    let cursor = 0
    let ticks = 0
    while (seen.size < items.length) {
      const r = pickRotation(items, cursor, 4)
      r.picked.forEach((s) => seen.add(s))
      cursor = r.nextCursor
      if (++ticks > 20) break
    }
    expect(seen.size).toBe(items.length)
    expect(ticks).toBeLessThanOrEqual(Math.ceil(17 / 4) + 1)
  })

  it('handles empty input and non-positive takes', () => {
    expect(pickRotation([], 3, 4)).toEqual({ picked: [], nextCursor: 0 })
    expect(pickRotation(['a'], 0, 0)).toEqual({ picked: [], nextCursor: 0 })
  })

  it('tolerates a cursor left over from a longer list', () => {
    // Sessions come and go, so the stored cursor can exceed the current length.
    expect(pickRotation(['a', 'b'], 97, 1).picked).toHaveLength(1)
  })
})
