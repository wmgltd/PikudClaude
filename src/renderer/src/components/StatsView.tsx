import { useEffect, useMemo, useState } from 'react'

type Range = 7 | 30 | 90 | 365

interface Summary {
  rangeDays: number
  startTs: number
  endTs: number
  totalPrompts: number
  totalActiveMs: number
  totalBookmarks: number
  projectsTouched: number
  hebrewPercent: number
  projects: Array<{
    cwd: string
    name: string
    prompts: number
    activeMs: number
    bookmarks: number
    sessions: number
    lastSeen: number
  }>
  byDay: Array<{ date: string; prompts: number; activeMs: number }>
  prev: {
    prompts: number
    activeMs: number
    bookmarks: number
    projectsTouched: number
  }
}

interface Heatmap {
  cells: number[][]
  max: number
  rangeDays: number
}

const RANGE_LABELS: Record<Range, string> = {
  7: 'Last 7 days',
  30: 'Last 30 days',
  90: 'Last 90 days',
  365: 'Last year'
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

interface Tip {
  text: string
  x: number
  y: number
}

export function StatsView(): JSX.Element {
  const [range, setRange] = useState<Range>(30)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [heatmap, setHeatmap] = useState<Heatmap | null>(null)
  const [loading, setLoading] = useState(true)
  const [tip, setTip] = useState<Tip | null>(null)
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([window.api.getStatsSummary(range), window.api.getStatsHeatmap(range)])
      .then(([s, h]) => {
        if (cancelled) return
        setSummary(s)
        setHeatmap(h)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [range])

  // Delegated hover tooltip: any element with data-tip under the stats view
  // gets a styled tooltip following the cursor. Beats `title` for instant
  // feedback (no ~500ms browser delay) and consistent styling.
  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]')
    if (!target) {
      if (tip) setTip(null)
      return
    }
    const text = target.dataset.tip || ''
    if (!text) {
      if (tip) setTip(null)
      return
    }
    setTip({ text, x: e.clientX, y: e.clientY })
  }
  const onMouseLeave = (): void => setTip(null)

  return (
    <div className="stats-view" onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
      {tip && <StatsTooltip tip={tip} />}
      {selectedCwd && (
        <ProjectDetailModal
          cwd={selectedCwd}
          rangeDays={range}
          onClose={() => setSelectedCwd(null)}
        />
      )}
      <div className="stats-header">
        <div className="stats-title">
          <h2>Stats</h2>
          <span className="stats-sub">your activity over time, per project</span>
        </div>
        <div className="stats-range" role="tablist">
          {(Object.keys(RANGE_LABELS) as Array<keyof typeof RANGE_LABELS>).map((k) => {
            const r = Number(k) as Range
            return (
              <button
                key={r}
                type="button"
                className={`stats-range-btn ${range === r ? 'active' : ''}`}
                onClick={() => setRange(r)}
              >
                {RANGE_LABELS[r]}
              </button>
            )
          })}
        </div>
      </div>

      {loading && <div className="stats-loading">loading…</div>}

      {!loading && summary && (
        <>
          <div className="stats-kpis">
            <KPI
              label="Prompts"
              value={summary.totalPrompts.toLocaleString()}
              hint={summary.hebrewPercent > 0 ? `${summary.hebrewPercent}% in Hebrew` : undefined}
              delta={computeDelta(summary.totalPrompts, summary.prev.prompts)}
              rangeDays={range}
            />
            <KPI
              label="Active hours"
              value={formatHours(summary.totalActiveMs)}
              hint="5-min activity buckets"
              delta={computeDelta(summary.totalActiveMs, summary.prev.activeMs)}
              rangeDays={range}
            />
            <KPI
              label="Projects touched"
              value={summary.projectsTouched.toString()}
              delta={computeDelta(summary.projectsTouched, summary.prev.projectsTouched)}
              rangeDays={range}
            />
            <KPI
              label="Bookmarks"
              value={summary.totalBookmarks.toString()}
              hint="created in range"
              delta={computeDelta(summary.totalBookmarks, summary.prev.bookmarks)}
              rangeDays={range}
            />
          </div>

          <ProjectColumnChart projects={summary.projects} onSelect={setSelectedCwd} />

          {heatmap && <HeatmapGrid heatmap={heatmap} />}

          <DailyTrend />

          {summary.projects.length === 0 && (
            <div className="stats-empty">
              no activity yet in this range. start a session and send some prompts —
              the dashboard will fill in over time.
            </div>
          )}
        </>
      )}
    </div>
  )
}

function StatsTooltip({ tip }: { tip: Tip }): JSX.Element {
  // Position above-and-right of the cursor; nudge inward if it would clip.
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(tip.x + 12, window.innerWidth - 280),
    top: Math.max(tip.y - 36, 8),
    pointerEvents: 'none',
    zIndex: 1000
  }
  return (
    <div className="stats-tip" style={style}>
      {tip.text}
    </div>
  )
}

interface Delta {
  kind: 'up' | 'down' | 'flat' | 'new'
  pct: number | null
}

function computeDelta(curr: number, prev: number): Delta {
  if (prev === 0 && curr === 0) return { kind: 'flat', pct: 0 }
  if (prev === 0) return { kind: 'new', pct: null }
  const pct = Math.round(((curr - prev) / prev) * 100)
  if (pct === 0) return { kind: 'flat', pct: 0 }
  return { kind: pct > 0 ? 'up' : 'down', pct }
}

function rangeLabel(days: Range): string {
  return days === 7 ? 'last week' : days === 30 ? 'previous month' : days === 90 ? 'previous quarter' : 'previous year'
}

function KPI({
  label,
  value,
  hint,
  delta,
  rangeDays
}: {
  label: string
  value: string
  hint?: string
  delta?: Delta
  rangeDays?: Range
}): JSX.Element {
  const prevLabel = rangeDays ? rangeLabel(rangeDays) : 'previous period'
  return (
    <div
      className="stats-kpi"
      data-tip={
        delta
          ? `${label}: ${value}${
              delta.kind === 'new'
                ? ` — no data for ${prevLabel}`
                : delta.kind === 'flat'
                ? ` — same as ${prevLabel}`
                : ` — ${delta.pct! > 0 ? '+' : ''}${delta.pct}% vs ${prevLabel}`
            }`
          : `${label}: ${value}${hint ? ` (${hint})` : ''}`
      }
    >
      <div className="stats-kpi-value">{value}</div>
      <div className="stats-kpi-row">
        <div className="stats-kpi-label">{label}</div>
        {delta && delta.kind !== 'new' && (
          <span className={`stats-kpi-delta delta-${delta.kind}`}>
            {delta.kind === 'up' && '▲ '}
            {delta.kind === 'down' && '▼ '}
            {delta.kind === 'flat' ? '—' : `${Math.abs(delta.pct!)}%`}
          </span>
        )}
        {delta && delta.kind === 'new' && (
          <span className="stats-kpi-delta delta-new">new</span>
        )}
      </div>
      {hint && <div className="stats-kpi-hint">{hint}</div>}
    </div>
  )
}

type ProjectMetric = 'time' | 'prompts'

function ProjectColumnChart({
  projects,
  onSelect
}: {
  projects: Summary['projects']
  onSelect: (cwd: string) => void
}): JSX.Element | null {
  const [metric, setMetric] = useState<ProjectMetric>('time')
  const top = useMemo(() => {
    const valueOf = (p: Summary['projects'][number]): number =>
      metric === 'time' ? p.activeMs : p.prompts
    return [...projects].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 10)
  }, [projects, metric])
  if (top.length === 0) return null
  const valueOf = (p: Summary['projects'][number]): number =>
    metric === 'time' ? p.activeMs : p.prompts
  const max = valueOf(top[0]) || 1
  const formatValue = (v: number): string =>
    metric === 'time' ? formatHours(v) : v.toLocaleString()

  return (
    <div className="stats-section">
      <div className="stats-section-head">
        <div className="stats-section-title">By Project</div>
        <div className="stats-metric-toggle" role="tablist">
          <button
            type="button"
            className={`stats-metric-btn ${metric === 'time' ? 'active' : ''}`}
            onClick={() => setMetric('time')}
          >
            Time
          </button>
          <button
            type="button"
            className={`stats-metric-btn ${metric === 'prompts' ? 'active' : ''}`}
            onClick={() => setMetric('prompts')}
          >
            Prompts
          </button>
        </div>
      </div>
      <div className="stats-cols">
        {top.map((p) => {
          const v = valueOf(p)
          const h = max > 0 ? (v / max) * 100 : 0
          return (
            <div
              key={p.cwd}
              className="stats-col stats-col-clickable"
              data-tip={`${p.name} — click for details. ${formatHours(p.activeMs)}, ${p.prompts.toLocaleString()} prompts${p.bookmarks ? `, ${p.bookmarks} bookmarks` : ''}`}
              onClick={() => onSelect(p.cwd)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(p.cwd)
                }
              }}
            >
              <div className="stats-col-bar-wrap">
                <div className="stats-col-value">{formatValue(v)}</div>
                <div className="stats-col-bar" style={{ height: `${Math.max(h, 2)}%` }} />
              </div>
              <div className="stats-col-label">{p.name}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HeatmapGrid({ heatmap }: { heatmap: Heatmap }): JSX.Element {
  const { cells, max } = heatmap
  return (
    <div className="stats-section">
      <div className="stats-section-title">When you work</div>
      <div className="stats-heatmap">
        <div className="stats-heatmap-corner" />
        {Array.from({ length: 24 }).map((_, h) => (
          <div key={`h${h}`} className="stats-heatmap-hour">
            {h % 6 === 0 ? h : ''}
          </div>
        ))}
        {cells.map((row, d) => (
          <Row key={`d${d}`} day={d} row={row} max={max} />
        ))}
      </div>
      <div className="stats-heatmap-legend">
        <span>less</span>
        <span className="stats-heatmap-legend-bar">
          {[0.1, 0.25, 0.5, 0.75, 1].map((v) => (
            <i key={v} style={{ background: heatColor(v) }} />
          ))}
        </span>
        <span>more</span>
      </div>
    </div>
  )
}

function Row({ day, row, max }: { day: number; row: number[]; max: number }): JSX.Element {
  return (
    <>
      <div className="stats-heatmap-day">{DAY_LABELS[day]}</div>
      {row.map((v, h) => {
        const intensity = max > 0 ? v / max : 0
        return (
          <div
            key={`d${day}h${h}`}
            className="stats-heatmap-cell"
            style={{ background: heatColor(intensity) }}
            data-tip={`${DAY_LABELS[day]} ${String(h).padStart(2, '0')}:00 — ${formatHours(v * 5 * 60 * 1000)} (${v} active ${v === 1 ? 'bucket' : 'buckets'})`}
          />
        )
      })}
    </>
  )
}

type DailyRange = 7 | 14 | 21 | 30

const DAILY_RANGES: DailyRange[] = [7, 14, 21, 30]

function DailyTrend(): JSX.Element {
  const [range, setRange] = useState<DailyRange>(7)
  const [data, setData] = useState<Summary['byDay']>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api
      .getStatsSummary(range)
      .then((s) => {
        if (cancelled) return
        setData(s.byDay)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [range])

  // Fill in every day in the window so gaps render as zero bars instead of
  // collapsing the chart. byDay only has days with activity.
  const filled = useMemo(() => filledDays(range, data), [range, data])
  const max = Math.max(...filled.map((d) => d.prompts), 1)

  return (
    <div className="stats-section">
      <div className="stats-section-head">
        <div className="stats-section-title">Prompts per day</div>
        <div className="stats-metric-toggle" role="tablist">
          {DAILY_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={`stats-metric-btn ${range === r ? 'active' : ''}`}
              onClick={() => setRange(r)}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="stats-loading">loading…</div>
      ) : (
        <div className="stats-daily">
          {filled.map((d) => {
            const h = (d.prompts / max) * 100
            return (
              <div
                key={d.date}
                className="stats-daily-col"
                data-tip={`${d.date} — ${d.prompts.toLocaleString()} prompts, ${formatHours(d.activeMs)} active`}
              >
                <div className="stats-daily-count">{d.prompts > 0 ? d.prompts.toLocaleString() : ''}</div>
                <div className="stats-daily-bar" style={{ height: `${Math.max(h, d.prompts > 0 ? 2 : 0)}%` }} />
                <div className="stats-daily-date">{d.date.slice(5)}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function heatColor(t: number): string {
  if (t === 0) return 'rgba(255,255,255,0.04)'
  // Purple ramp matching the app's accent
  const alpha = 0.15 + t * 0.7
  return `rgba(167, 139, 250, ${alpha.toFixed(3)})`
}

function formatHours(ms: number): string {
  if (ms < 60_000) return '0m'
  const totalMin = Math.round(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function dateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function filledDays(
  rangeDays: number,
  byDay: Summary['byDay']
): Summary['byDay'] {
  const map = new Map(byDay.map((d) => [d.date, d]))
  const out: Summary['byDay'] = []
  const today = new Date()
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    const key = dateKey(d)
    const found = map.get(key)
    out.push(found ?? { date: key, prompts: 0, activeMs: 0 })
  }
  return out
}

interface ProjectDetailData {
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

function ProjectDetailModal({
  cwd,
  rangeDays,
  onClose
}: {
  cwd: string
  rangeDays: Range
  onClose: () => void
}): JSX.Element {
  const [data, setData] = useState<ProjectDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api
      .getProjectDetail(cwd, rangeDays)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, rangeDays])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]')
    if (!target) {
      if (tip) setTip(null)
      return
    }
    const text = target.dataset.tip || ''
    if (!text) return
    setTip({ text, x: e.clientX, y: e.clientY })
  }

  const peakHour = useMemo(() => {
    if (!data) return null
    let max = 0
    let idx = -1
    data.byHour.forEach((v, i) => {
      if (v > max) {
        max = v
        idx = i
      }
    })
    return max > 0 ? { hour: idx, count: max } : null
  }, [data])

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog project-detail-dialog"
        onClick={(e) => e.stopPropagation()}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setTip(null)}
      >
        {tip && <StatsTooltip tip={tip} />}
        <div className="project-detail-header">
          <div>
            <h2>{data?.name ?? '…'}</h2>
            <div className="project-detail-path">{cwd}</div>
          </div>
          <button
            type="button"
            className="scrollback-close"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {loading && <div className="stats-loading">loading…</div>}
        {!loading && !data && (
          <div className="stats-empty">no activity recorded for this project</div>
        )}
        {!loading && data && (
          <div className="project-detail-body">
            <div className="stats-kpis">
              <KPI
                label="Prompts"
                value={data.totalPrompts.toLocaleString()}
                hint={data.hebrewPercent > 0 ? `${data.hebrewPercent}% in Hebrew` : undefined}
                delta={computeDelta(data.totalPrompts, data.prev.prompts)}
                rangeDays={rangeDays}
              />
              <KPI
                label="Active hours"
                value={formatHours(data.totalActiveMs)}
                delta={computeDelta(data.totalActiveMs, data.prev.activeMs)}
                rangeDays={rangeDays}
              />
              <KPI
                label="Sessions"
                value={data.sessions.toString()}
              />
              <KPI
                label="Bookmarks"
                value={data.bookmarks.toString()}
                delta={computeDelta(data.bookmarks, data.prev.bookmarks)}
                rangeDays={rangeDays}
              />
            </div>

            <div className="stats-section">
              <div className="stats-section-title">By hour of day</div>
              <ByHourBars hours={data.byHour} peakHour={peakHour} />
            </div>

            {data.byDay.length > 0 && (
              <div className="stats-section">
                <div className="stats-section-title">Daily activity</div>
                <div className="stats-daily">
                  {data.byDay.map((d) => {
                    const max = Math.max(...data.byDay.map((x) => x.prompts), 1)
                    const h = (d.prompts / max) * 100
                    return (
                      <div
                        key={d.date}
                        className="stats-daily-col"
                        data-tip={`${d.date} — ${d.prompts.toLocaleString()} prompts, ${formatHours(d.activeMs)} active`}
                      >
                        <div className="stats-daily-bar" style={{ height: `${Math.max(h, 2)}%` }} />
                        <div className="stats-daily-date">{d.date.slice(5)}</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="project-detail-meta">
              <div>
                <span className="project-detail-meta-label">First activity</span>
                <span>{data.firstSeen ? new Date(data.firstSeen).toLocaleString() : '—'}</span>
              </div>
              <div>
                <span className="project-detail-meta-label">Last activity</span>
                <span>{data.lastSeen ? new Date(data.lastSeen).toLocaleString() : '—'}</span>
              </div>
              {peakHour && (
                <div>
                  <span className="project-detail-meta-label">Peak hour</span>
                  <span>
                    {String(peakHour.hour).padStart(2, '0')}:00 · {formatHours(peakHour.count * 5 * 60 * 1000)}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ByHourBars({
  hours,
  peakHour
}: {
  hours: number[]
  peakHour: { hour: number; count: number } | null
}): JSX.Element {
  const max = Math.max(...hours, 1)
  return (
    <div className="stats-hour-bars">
      {hours.map((v, h) => {
        const pct = (v / max) * 100
        const isPeak = peakHour?.hour === h && v > 0
        return (
          <div
            key={h}
            className={`stats-hour-col ${isPeak ? 'peak' : ''}`}
            data-tip={`${String(h).padStart(2, '0')}:00 — ${formatHours(v * 5 * 60 * 1000)} (${v} active ${v === 1 ? 'bucket' : 'buckets'})`}
          >
            <div className="stats-hour-bar" style={{ height: `${Math.max(pct, v > 0 ? 4 : 0)}%` }} />
            {h % 3 === 0 && <div className="stats-hour-label">{h}</div>}
          </div>
        )
      })}
    </div>
  )
}
