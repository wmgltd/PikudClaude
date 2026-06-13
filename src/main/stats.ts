import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

// ---------- Event log ----------
// Append-only metadata stream. NO prompt text is stored here — prompt_sent
// only records length + a language hint. Each line is a self-contained JSON
// object so partial writes (crash mid-append) only corrupt the last line and
// the rest is still readable.

export type EventType =
  | 'prompt_sent'
  | 'status_change'
  | 'session_created'
  | 'session_closed'
  | 'bookmark_created'

interface BaseEvent {
  ts: number
  type: EventType
  sessionId: string
  cwd: string
}

export interface PromptSentEvent extends BaseEvent {
  type: 'prompt_sent'
  len: number
  hebrew: boolean
}
export interface StatusChangeEvent extends BaseEvent {
  type: 'status_change'
  status: 'working' | 'idle' | 'awaiting' | 'detached'
}
export interface SessionCreatedEvent extends BaseEvent {
  type: 'session_created'
  name: string
}
export interface SessionClosedEvent extends BaseEvent {
  type: 'session_closed'
}
export interface BookmarkCreatedEvent extends BaseEvent {
  type: 'bookmark_created'
}

export type StatsEvent =
  | PromptSentEvent
  | StatusChangeEvent
  | SessionCreatedEvent
  | SessionClosedEvent
  | BookmarkCreatedEvent

const HEBREW_RE = /[֐-׿]/

function eventsFile(): string {
  return join(app.getPath('userData'), 'events.jsonl')
}

export function recordPromptSent(sessionId: string, cwd: string, text: string): void {
  recordEvent({
    type: 'prompt_sent',
    sessionId,
    cwd,
    len: text.length,
    hebrew: HEBREW_RE.test(text)
  })
}

export function recordStatusChange(
  sessionId: string,
  cwd: string,
  status: StatusChangeEvent['status']
): void {
  recordEvent({ type: 'status_change', sessionId, cwd, status })
}

export function recordSessionCreated(sessionId: string, cwd: string, name: string): void {
  recordEvent({ type: 'session_created', sessionId, cwd, name })
}

export function recordSessionClosed(sessionId: string, cwd: string): void {
  recordEvent({ type: 'session_closed', sessionId, cwd })
}

export function recordBookmarkCreated(sessionId: string, cwd: string): void {
  recordEvent({ type: 'bookmark_created', sessionId, cwd })
}

function recordEvent(partial: Omit<StatsEvent, 'ts'>): void {
  if (!partial.cwd || !partial.sessionId) return
  const evt = { ts: Date.now(), ...partial } as StatsEvent
  try {
    appendFileSync(eventsFile(), JSON.stringify(evt) + '\n', 'utf8')
  } catch {
    /* ignore — analytics must never crash the app */
  }
}

// ---------- Aggregation ----------

const DAY_MS = 24 * 60 * 60 * 1000
const BUCKET_MS = 5 * 60 * 1000 // 5-minute active-time buckets
const BUCKETS_PER_DAY = DAY_MS / BUCKET_MS // 288

export interface ProjectStats {
  cwd: string
  name: string
  prompts: number
  activeMs: number
  bookmarks: number
  sessions: number
  lastSeen: number
}

export interface PeriodTotals {
  prompts: number
  activeMs: number
  bookmarks: number
  projectsTouched: number
}

export interface Summary {
  rangeDays: number
  startTs: number
  endTs: number
  totalPrompts: number
  totalActiveMs: number
  totalBookmarks: number
  projectsTouched: number
  hebrewPercent: number
  projects: ProjectStats[]
  byDay: Array<{ date: string; prompts: number; activeMs: number }>
  // Same metrics for the period immediately preceding this one (e.g., for
  // rangeDays=7, prev is the 7 days before that). Used for delta display.
  prev: PeriodTotals
}

export interface Heatmap {
  // [dayOfWeek 0=Sunday..6=Saturday][hour 0..23] = number of buckets active
  cells: number[][]
  max: number
  rangeDays: number
}

export function readEventsForDay(dayKey: string): StatsEvent[] {
  const [y, m, d] = dayKey.split('-').map((n) => Number(n))
  if (!y || !m || !d) return []
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  const end = start + DAY_MS
  return readAllEvents().filter((e) => e.ts >= start && e.ts < end)
}

function readAllEvents(): StatsEvent[] {
  const path = eventsFile()
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: StatsEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as StatsEvent)
    } catch {
      /* skip malformed */
    }
  }
  return out
}

function dateKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function projectDisplayName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '')
  const parts = trimmed.split('/')
  return parts[parts.length - 1] || cwd
}

function aggregateTotals(events: StatsEvent[]): PeriodTotals {
  const buckets = new Set<number>()
  const cwds = new Set<string>()
  let prompts = 0
  let bookmarks = 0
  for (const e of events) {
    if (!e.cwd) continue
    const meaningful =
      e.type === 'prompt_sent' ||
      e.type === 'bookmark_created' ||
      (e.type === 'status_change' && (e.status === 'working' || e.status === 'awaiting'))
    if (meaningful) {
      cwds.add(e.cwd)
      buckets.add(Math.floor(e.ts / BUCKET_MS))
    }
    if (e.type === 'prompt_sent') prompts++
    else if (e.type === 'bookmark_created') bookmarks++
  }
  return {
    prompts,
    activeMs: buckets.size * BUCKET_MS,
    bookmarks,
    projectsTouched: cwds.size
  }
}

export function getSummary(rangeDays: number): Summary {
  const now = Date.now()
  const startTs = now - rangeDays * DAY_MS
  const prevStartTs = startTs - rangeDays * DAY_MS
  const allEvents = readAllEvents()
  const events = allEvents.filter((e) => e.ts >= startTs && e.ts <= now)
  const prevEvents = allEvents.filter((e) => e.ts >= prevStartTs && e.ts < startTs)
  const prev = aggregateTotals(prevEvents)

  // Per-project aggregation
  const proj = new Map<string, ProjectStats & { _activeBuckets: Set<number>; _sessions: Set<string> }>()
  // Daily aggregation
  const dayMap = new Map<string, { prompts: number; activeBuckets: Set<number> }>()
  // Global active buckets (any project)
  const globalActiveBuckets = new Set<number>()
  let totalPrompts = 0
  let totalBookmarks = 0
  let hebrewPrompts = 0

  const bucketOf = (ts: number): number => Math.floor(ts / BUCKET_MS)

  for (const e of events) {
    const cwd = e.cwd
    if (!proj.has(cwd)) {
      proj.set(cwd, {
        cwd,
        name: projectDisplayName(cwd),
        prompts: 0,
        activeMs: 0,
        bookmarks: 0,
        sessions: 0,
        lastSeen: 0,
        _activeBuckets: new Set(),
        _sessions: new Set()
      })
    }
    const p = proj.get(cwd)!
    p.lastSeen = Math.max(p.lastSeen, e.ts)
    p._sessions.add(e.sessionId)

    const dk = dateKey(e.ts)
    if (!dayMap.has(dk)) dayMap.set(dk, { prompts: 0, activeBuckets: new Set() })
    const day = dayMap.get(dk)!

    // Anything except 'detached'/'idle' counts as "doing something". To keep
    // active-time honest, only count buckets that have meaningful signal:
    // prompts sent or status going to working/awaiting.
    const isMeaningful =
      e.type === 'prompt_sent' ||
      e.type === 'bookmark_created' ||
      (e.type === 'status_change' && (e.status === 'working' || e.status === 'awaiting'))

    if (isMeaningful) {
      const b = bucketOf(e.ts)
      p._activeBuckets.add(b)
      day.activeBuckets.add(b)
      globalActiveBuckets.add(b)
    }

    if (e.type === 'prompt_sent') {
      p.prompts++
      totalPrompts++
      day.prompts++
      if (e.hebrew) hebrewPrompts++
    } else if (e.type === 'bookmark_created') {
      p.bookmarks++
      totalBookmarks++
    }
  }

  const projects: ProjectStats[] = Array.from(proj.values())
    .map((p) => ({
      cwd: p.cwd,
      name: p.name,
      prompts: p.prompts,
      activeMs: p._activeBuckets.size * BUCKET_MS,
      bookmarks: p.bookmarks,
      sessions: p._sessions.size,
      lastSeen: p.lastSeen
    }))
    .sort((a, b) => b.activeMs - a.activeMs)

  const byDay = Array.from(dayMap.entries())
    .map(([date, d]) => ({
      date,
      prompts: d.prompts,
      activeMs: d.activeBuckets.size * BUCKET_MS
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  return {
    rangeDays,
    startTs,
    endTs: now,
    totalPrompts,
    totalActiveMs: globalActiveBuckets.size * BUCKET_MS,
    totalBookmarks,
    projectsTouched: projects.filter((p) => p.prompts > 0 || p.activeMs > 0).length,
    hebrewPercent: totalPrompts > 0 ? Math.round((hebrewPrompts / totalPrompts) * 100) : 0,
    projects,
    byDay,
    prev
  }
}

export interface ProjectDetail {
  cwd: string
  name: string
  rangeDays: number
  totalPrompts: number
  totalActiveMs: number
  bookmarks: number
  sessions: number
  hebrewPercent: number
  firstSeen: number
  lastSeen: number
  byDay: Array<{ date: string; prompts: number; activeMs: number }>
  byHour: number[]
  prev: { prompts: number; activeMs: number; bookmarks: number }
}

export function getProjectDetail(cwd: string, rangeDays: number): ProjectDetail | null {
  const now = Date.now()
  const startTs = now - rangeDays * DAY_MS
  const prevStartTs = startTs - rangeDays * DAY_MS
  const allEvents = readAllEvents().filter((e) => e.cwd === cwd)
  if (allEvents.length === 0) return null
  const events = allEvents.filter((e) => e.ts >= startTs && e.ts <= now)
  const prevEvents = allEvents.filter((e) => e.ts >= prevStartTs && e.ts < startTs)

  const dayMap = new Map<string, { prompts: number; activeBuckets: Set<number> }>()
  const byHour: Array<Set<number>> = Array.from({ length: 24 }, () => new Set<number>())
  const sessions = new Set<string>()
  const activeBuckets = new Set<number>()
  let prompts = 0
  let bookmarks = 0
  let hebrewPrompts = 0
  let firstSeen = Infinity
  let lastSeen = -Infinity

  for (const e of events) {
    sessions.add(e.sessionId)
    if (e.ts < firstSeen) firstSeen = e.ts
    if (e.ts > lastSeen) lastSeen = e.ts

    const meaningful =
      e.type === 'prompt_sent' ||
      e.type === 'bookmark_created' ||
      (e.type === 'status_change' && (e.status === 'working' || e.status === 'awaiting'))

    const dk = dateKey(e.ts)
    if (!dayMap.has(dk)) dayMap.set(dk, { prompts: 0, activeBuckets: new Set() })
    const day = dayMap.get(dk)!

    if (meaningful) {
      const b = Math.floor(e.ts / BUCKET_MS)
      activeBuckets.add(b)
      day.activeBuckets.add(b)
      byHour[new Date(e.ts).getHours()].add(b)
    }
    if (e.type === 'prompt_sent') {
      prompts++
      day.prompts++
      if (e.hebrew) hebrewPrompts++
    } else if (e.type === 'bookmark_created') {
      bookmarks++
    }
  }

  const prev = aggregateTotals(prevEvents)
  const byDay = Array.from(dayMap.entries())
    .map(([date, d]) => ({
      date,
      prompts: d.prompts,
      activeMs: d.activeBuckets.size * BUCKET_MS
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  return {
    cwd,
    name: projectDisplayName(cwd),
    rangeDays,
    totalPrompts: prompts,
    totalActiveMs: activeBuckets.size * BUCKET_MS,
    bookmarks,
    sessions: sessions.size,
    hebrewPercent: prompts > 0 ? Math.round((hebrewPrompts / prompts) * 100) : 0,
    firstSeen: firstSeen === Infinity ? 0 : firstSeen,
    lastSeen: lastSeen === -Infinity ? 0 : lastSeen,
    byDay,
    byHour: byHour.map((s) => s.size),
    prev: { prompts: prev.prompts, activeMs: prev.activeMs, bookmarks: prev.bookmarks }
  }
}

export function getHeatmap(rangeDays: number): Heatmap {
  const now = Date.now()
  const startTs = now - rangeDays * DAY_MS
  const events = readAllEvents().filter((e) => e.ts >= startTs && e.ts <= now)

  // Per-(dayOfWeek,hour) we track the SET of unique 5-min buckets that had
  // meaningful activity, then count the set size. This deduplicates many
  // events that landed in the same bucket without double-counting time.
  const cells: Array<Array<Set<number>>> = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => new Set<number>())
  )

  for (const e of events) {
    const isMeaningful =
      e.type === 'prompt_sent' ||
      e.type === 'bookmark_created' ||
      (e.type === 'status_change' && (e.status === 'working' || e.status === 'awaiting'))
    if (!isMeaningful) continue
    const d = new Date(e.ts)
    const dow = d.getDay()
    const hour = d.getHours()
    const bucket = Math.floor(e.ts / BUCKET_MS)
    cells[dow][hour].add(bucket)
  }

  const counts = cells.map((row) => row.map((s) => s.size))
  let max = 0
  for (const row of counts) for (const v of row) if (v > max) max = v

  return { cells: counts, max, rangeDays }
}

// Suppress lint for currently-unused per-day bucket constant — exported for
// future drill-down views.
export { BUCKETS_PER_DAY }
