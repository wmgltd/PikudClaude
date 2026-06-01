import { app } from 'electron'
import { join } from 'node:path'
import type { SessionMeta } from './types'
import { writeAtomic, loadWithFallback } from './atomic'

const STORE_FILE = (): string => join(app.getPath('userData'), 'sessions.json')

export function loadSessions(): SessionMeta[] {
  return (
    loadWithFallback<SessionMeta[]>(STORE_FILE(), (raw) => {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as SessionMeta[]) : null
    }) ?? []
  )
}

export function saveSessions(sessions: SessionMeta[]): void {
  writeAtomic(STORE_FILE(), JSON.stringify(sessions, null, 2))
}

const PROMPTS_FILE = (): string => join(app.getPath('userData'), 'promptHistory.json')

export interface PromptEntry {
  text: string
  ts: number
}

export function loadPromptHistory(): Record<string, PromptEntry[]> {
  return (
    loadWithFallback<Record<string, PromptEntry[]>>(PROMPTS_FILE(), (raw) => {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const out: Record<string, PromptEntry[]> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(v)) continue
        const entries: PromptEntry[] = []
        for (const item of v) {
          if (typeof item === 'string') {
            entries.push({ text: item, ts: 0 }) // migrate string[] format
          } else if (item && typeof item === 'object' && 'text' in item) {
            const rec = item as { text?: unknown; ts?: unknown }
            if (typeof rec.text === 'string') {
              entries.push({ text: rec.text, ts: typeof rec.ts === 'number' ? rec.ts : 0 })
            }
          }
        }
        out[k] = entries
      }
      return out
    }) ?? {}
  )
}

export function savePromptHistory(history: Record<string, PromptEntry[]>): void {
  writeAtomic(PROMPTS_FILE(), JSON.stringify(history, null, 2))
}

const STATS_FILE = (): string => join(app.getPath('userData'), 'promptStats.json')

export function loadPromptStats(): Record<string, number[]> {
  return (
    loadWithFallback<Record<string, number[]>>(STATS_FILE(), (raw) => {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const out: Record<string, number[]> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          out[k] = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
        }
      }
      return out
    }) ?? {}
  )
}

export function savePromptStats(stats: Record<string, number[]>): void {
  writeAtomic(STATS_FILE(), JSON.stringify(stats, null, 2))
}
