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
            <KPI label="Prompts" value={summary.totalPrompts.toLocaleString()} hint={
              summary.hebrewPercent > 0 ? `${summary.hebrewPercent}% in Hebrew` : undefined
            } />
            <KPI label="Active hours" value={formatHours(summary.totalActiveMs)} hint="5-min activity buckets" />
            <KPI label="Projects touched" value={summary.projectsTouched.toString()} />
            <KPI label="Bookmarks" value={summary.totalBookmarks.toString()} hint="created in range" />
          </div>

          <ProjectColumnChart projects={summary.projects} />

          {heatmap && <HeatmapGrid heatmap={heatmap} />}

          {summary.byDay.length > 0 && (
            <DailyTrend byDay={summary.byDay} />
          )}

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

function KPI({
  label,
  value,
  hint
}: {
  label: string
  value: string
  hint?: string
}): JSX.Element {
  return (
    <div className="stats-kpi" data-tip={`${label}: ${value}${hint ? ` (${hint})` : ''}`}>
      <div className="stats-kpi-value">{value}</div>
      <div className="stats-kpi-label">{label}</div>
      {hint && <div className="stats-kpi-hint">{hint}</div>}
    </div>
  )
}

type ProjectMetric = 'time' | 'prompts'

function ProjectColumnChart({
  projects
}: {
  projects: Summary['projects']
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
              className="stats-col"
              data-tip={`${p.name} — ${formatHours(p.activeMs)}, ${p.prompts.toLocaleString()} prompts${p.bookmarks ? `, ${p.bookmarks} bookmarks` : ''}`}
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

function DailyTrend({ byDay }: { byDay: Summary['byDay'] }): JSX.Element {
  const max = Math.max(...byDay.map((d) => d.prompts), 1)
  return (
    <div className="stats-section">
      <div className="stats-section-title">Prompts per day</div>
      <div className="stats-daily">
        {byDay.map((d) => {
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
