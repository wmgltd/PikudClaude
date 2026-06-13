import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readEventsForDay } from './stats'
import { settings } from './settingsSingleton'

const ENDPOINT = 'https://api.pikud.io/v1/heartbeat'
const ANON_ID_FILE = (): string => join(app.getPath('userData'), 'anon-id.txt')
const DAY_MS = 24 * 60 * 60 * 1000
const BUCKET_MS = 5 * 60 * 1000

export interface HeartbeatPayload {
  anon_id: string
  day: string
  app: {
    version: string
    os: 'darwin' | 'win32' | 'linux'
    os_version: string
    arch: string
    locale: string
  }
  usage: {
    prompts: number
    active_minutes: number
    sessions_opened: number
    projects_touched: number
    bookmarks_created: number
    ide_jumps: number
    command_palette_opens: number
  }
  features: {
    used_hebrew_today: boolean
    used_conversation_panel: boolean
    used_stats_view: boolean
    used_search: boolean
    used_scrollback_overlay: boolean
    preferred_ide: string
  }
}

let cachedAnonId: string | null = null
let dayCounters = freshCounters()
let dayCountersKey = todayKey()

interface DayCounters {
  ideJumps: number
  paletteOpens: number
  conversationPanelOpened: boolean
  statsViewOpened: boolean
  searchUsed: boolean
  scrollbackOverlayUsed: boolean
}

function freshCounters(): DayCounters {
  return {
    ideJumps: 0,
    paletteOpens: 0,
    conversationPanelOpened: false,
    statsViewOpened: false,
    searchUsed: false,
    scrollbackOverlayUsed: false
  }
}

function rollCountersIfNewDay(): void {
  const key = todayKey()
  if (key !== dayCountersKey) {
    dayCounters = freshCounters()
    dayCountersKey = key
  }
}

export function recordIdeJump(): void {
  rollCountersIfNewDay()
  dayCounters.ideJumps++
}
export function recordPaletteOpen(): void {
  rollCountersIfNewDay()
  dayCounters.paletteOpens++
}
export function recordConversationPanelOpened(): void {
  rollCountersIfNewDay()
  dayCounters.conversationPanelOpened = true
}
export function recordStatsViewOpened(): void {
  rollCountersIfNewDay()
  dayCounters.statsViewOpened = true
}
export function recordSearchUsed(): void {
  rollCountersIfNewDay()
  dayCounters.searchUsed = true
}
export function recordScrollbackOverlayUsed(): void {
  rollCountersIfNewDay()
  dayCounters.scrollbackOverlayUsed = true
}

export function getAnonId(): string {
  if (cachedAnonId) return cachedAnonId
  const file = ANON_ID_FILE()
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, 'utf8').trim()
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
        cachedAnonId = raw
        return raw
      }
    } catch {
      /* fall through to generate a new one */
    }
  }
  const id = randomUUID()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, id, 'utf8')
  } catch {
    /* if we can't persist, the id still works for this session */
  }
  cachedAnonId = id
  return id
}

export function resetAnonId(): string {
  cachedAnonId = null
  try {
    writeFileSync(ANON_ID_FILE(), '', 'utf8')
  } catch {
    /* ignore — next getAnonId call regenerates anyway */
  }
  return getAnonId()
}

export function buildPayload(day: string): HeartbeatPayload {
  const events = readEventsForDay(day)
  const buckets = new Set<number>()
  const sessions = new Set<string>()
  const projects = new Set<string>()
  let prompts = 0
  let bookmarks = 0
  let usedHebrew = false

  for (const e of events) {
    if (!e.cwd) continue
    if (e.type === 'session_created') sessions.add(e.sessionId)
    projects.add(e.cwd)

    const meaningful =
      e.type === 'prompt_sent' ||
      e.type === 'bookmark_created' ||
      (e.type === 'status_change' && (e.status === 'working' || e.status === 'awaiting'))
    if (meaningful) buckets.add(Math.floor(e.ts / BUCKET_MS))

    if (e.type === 'prompt_sent') {
      prompts++
      if (e.hebrew) usedHebrew = true
    } else if (e.type === 'bookmark_created') {
      bookmarks++
    }
  }

  // Sessions_opened counts session_created events for the day. If no
  // session_created events for the day (the user just resumed from yesterday),
  // fall back to the number of distinct session ids that had any activity.
  if (sessions.size === 0) {
    for (const e of events) if (e.sessionId) sessions.add(e.sessionId)
  }

  // dayCounters reflect today — if we're sending a payload for an earlier
  // day, the per-feature flags below are best-effort. We accept this trade-off
  // rather than persist per-day counters to disk.
  const counters = day === dayCountersKey ? dayCounters : freshCounters()
  const preferredIDE = settings.get().sessions.preferredIDE

  return {
    anon_id: getAnonId(),
    day,
    app: {
      version: app.getVersion(),
      os: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
      os_version: process.getSystemVersion?.() || '',
      arch: process.arch,
      locale: app.getLocale()
    },
    usage: {
      prompts,
      active_minutes: Math.round((buckets.size * BUCKET_MS) / 60000),
      sessions_opened: sessions.size,
      projects_touched: projects.size,
      bookmarks_created: bookmarks,
      ide_jumps: counters.ideJumps,
      command_palette_opens: counters.paletteOpens
    },
    features: {
      used_hebrew_today: usedHebrew,
      used_conversation_panel: counters.conversationPanelOpened,
      used_stats_view: counters.statsViewOpened,
      used_search: counters.searchUsed,
      used_scrollback_overlay: counters.scrollbackOverlayUsed,
      preferred_ide: preferredIDE
    }
  }
}

async function send(payload: HeartbeatPayload): Promise<boolean> {
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return r.status === 204
  } catch {
    return false
  }
}

export async function maybeSendHeartbeat(): Promise<void> {
  const s = settings.get()
  if (!s.telemetry.enabled) return

  const now = Date.now()
  if (now - s.telemetry.lastHeartbeatAt < DAY_MS) return

  // Send for YESTERDAY — yesterday's day is fully closed, so the roll-up is
  // stable. Today's data goes out tomorrow.
  const yesterday = dayKey(now - DAY_MS)
  const payload = buildPayload(yesterday)
  const ok = await send(payload)
  if (ok) {
    // Re-read settings — the user may have toggled telemetry off DURING the
    // fetch. Don't clobber their decision; only bump lastHeartbeatAt.
    const cur = settings.get()
    settings.save({
      telemetry: {
        enabled: cur.telemetry.enabled,
        consentShownAt: cur.telemetry.consentShownAt,
        lastHeartbeatAt: now
      }
    })
  }
}

let scheduler: NodeJS.Timeout | null = null

export function startScheduler(): void {
  // Try once on startup (after a short delay so the app finishes booting),
  // then every 6 hours. maybeSendHeartbeat() itself is the rate-limiter.
  setTimeout(() => {
    maybeSendHeartbeat().catch(() => undefined)
  }, 30_000)
  if (scheduler) clearInterval(scheduler)
  scheduler = setInterval(
    () => {
      maybeSendHeartbeat().catch(() => undefined)
    },
    6 * 60 * 60 * 1000
  )
}

export function stopScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler)
    scheduler = null
  }
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function todayKey(): string {
  return dayKey(Date.now())
}

// Re-export so the renderer's "see what's sent" preview can read today's
// in-progress payload too.
export function previewToday(): HeartbeatPayload {
  return buildPayload(todayKey())
}
