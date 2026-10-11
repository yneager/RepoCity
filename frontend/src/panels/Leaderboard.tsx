import { useMemo, useState } from 'react'
import { filterMasks, formatNumber, leaderboard, rampColor, RISK_STOPS, type RankMetric } from '../data/transforms'
import { useCity } from '../store'

const TABS: { id: RankMetric; label: string }[] = [
  { id: 'risk', label: 'Riskiest' },
  { id: 'churn', label: 'Most changed' },
  { id: 'fixes', label: 'Most fixed' },
]

/** Top files for the current month. Hover = highlight in the city, click = fly there. */
export function Leaderboard() {
  const layout = useCity((s) => s.layout)
  const snapshot = useCity((s) => s.snapshot)
  const hideTests = useCity((s) => s.hideTests)
  const select = useCity((s) => s.select)
  const setHovered = useCity((s) => s.setHovered)
  const selected = useCity((s) => s.selected)
  const [tab, setTab] = useState<RankMetric>('risk')
  const hidden = useMemo(() => (layout && hideTests ? filterMasks(layout.files.path, { hideTests, pathFilter: '', district: null }).hidden : undefined), [layout, hideTests])
  const rows = useMemo(() => (snapshot ? leaderboard(snapshot, tab, 8, hidden) : []), [snapshot, tab, hidden])
  if (!layout || !snapshot) return null
  const col = tab === 'risk' ? snapshot.risk : tab === 'churn' ? snapshot.churn : snapshot.fixes
  const max = rows.length ? Math.max(1e-9, col[rows[0]]) : 1
  return (
    <div className="panel p-4" data-testid="leaderboard">
      <div className="seg w-full" role="tablist" aria-label="Ranking">
        {TABS.map((t) => (
          <button key={t.id} className="flex-1 !px-1.5 !text-[11.5px]" aria-pressed={tab === t.id} onClick={() => setTab(t.id)} role="tab">
            {t.label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-[12px] text-slate-500">{tab === 'risk' ? 'No predictions for this month yet.' : 'Nothing to rank in this month.'}</p>
      ) : (
        <ol className="mt-2.5 space-y-1" key={tab}>
          {rows.map((i, k) => {
            const p = layout.files.path[i]
            const v = col[i]
            const frac = tab === 'risk' ? v : v / max
            const color = tab === 'risk' ? `rgb(${rampColor(RISK_STOPS, v).map((c) => Math.round(c * 255)).join(',')})` : tab === 'fixes' ? '#fb7185' : '#38bdf8'
            return (
              <li key={i} className="animate-[rise_var(--dur)_var(--ease-out)_both]" style={{ animationDelay: `calc(var(--motion) * ${k * 55}ms)` }}>
                <button
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => select(i, true)}
                  className={`group w-full rounded-lg px-2 py-1 text-left hover:bg-slate-800/80 ${selected === i ? 'bg-sky-400/10' : ''}`}
                  data-testid="leaderboard-row"
                >
                  <div className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="truncate text-slate-200 group-hover:text-white" title={p}>{p.slice(p.lastIndexOf('/') + 1)}</span>
                    <span className="shrink-0 tabular-nums text-slate-400">{tab === 'risk' ? `${Math.round(v * 100)}` : formatNumber(v)}</span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-slate-800">
                    <div className="bar-fill h-1 rounded-full" style={{ width: `${Math.max(3, frac * 100)}%`, background: color }} />
                  </div>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
