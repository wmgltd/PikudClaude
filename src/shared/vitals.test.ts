import { describe, expect, it } from 'vitest'
import { formatIdle, formatMB, STALE_SESSION_MS } from './vitals'

describe('formatIdle', () => {
  it('uses minutes, then hours, then days', () => {
    expect(formatIdle(5 * 60_000)).toBe('5m')
    expect(formatIdle(59 * 60_000)).toBe('59m')
    expect(formatIdle(60 * 60_000)).toBe('1h')
    expect(formatIdle(23 * 3600_000)).toBe('23h')
    expect(formatIdle(24 * 3600_000)).toBe('1d')
    expect(formatIdle(89.5 * 3600_000)).toBe('3d')
  })

  it('never renders a bare "0m" for a session that was just used', () => {
    expect(formatIdle(0)).toBe('1m')
    expect(formatIdle(900)).toBe('1m')
  })
})

describe('formatMB', () => {
  it('switches to GB above 1024MB', () => {
    expect(formatMB(185)).toBe('185MB')
    expect(formatMB(1023)).toBe('1023MB')
    expect(formatMB(1024)).toBe('1.0GB')
    expect(formatMB(2300)).toBe('2.2GB')
  })
})

describe('STALE_SESSION_MS', () => {
  it('is one day', () => {
    expect(STALE_SESSION_MS).toBe(86_400_000)
  })
})
