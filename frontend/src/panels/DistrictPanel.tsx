import { useMemo } from 'react'
import { districtStats, formatMonth, formatNumber } from '../data/transforms'
import { cachedSnapshot, useCity } from '../store'
import { AnimatedNumber, Icon, Stat } from '../ui'

/** Summary of the selected district (directory): size, activity, risk, its riskiest files and its growth. */
export function DistrictPanel() {
  const layout = useCity((s) => s.layout)
  const snapshot = useCity((s) => s.snapshot)
  const meta = useCity((s) => s.meta)
  const idx = useCity((s) => s.selectedDistrict)
  const selectDistrict = useCity((s) => s.selectDistrict)
  const select = useCity((s) => s.select)
  const setHovered = useCity((s) => s.setHovered)
  const loaded = useCity((s) => s.snapshotsLoaded)
  const monthIndex = useCity((s) => s.monthIndex)
  const d = idx != null && layout ? layout.districts[idx] : null
  const stats = useMemo(() => (d && layout && snapshot ? districtStats(layout, snapshot, d.path) : null), [d, layout, snapshot])

  // LOC of the district over time, from the months already loaded
  const growth = useMemo(() => {
    if (!d || !layout || !meta) return null
    const prefix = `${d.path}/`
    const members = layout.files.path.map((p, i) => (p.startsWith(prefix) ? i : -1)).filter((i) => i >= 0)
    return meta.months.map((m) => {
      const s = cachedSnapshot(m)
      if (!s) return null
      let loc = 0
      for (const i of members) loc += s.loc[i]
      return loc
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, layout, meta, loaded])

  if (!d || !stats || !meta) return null
  const vals = (growth ?? []).map((v) => v ?? 0)
  const max = Math.max(1, ...vals)
  const w = 300
  const h = 46
  const step = vals.length > 1 ? w / (vals.length - 1) : w
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 3 - (v / max) * (h - 6)).toFixed(1)}`)

  return (
    <aside className="panel pointer-events-auto w-[360px] overflow-hidden animate-slide-in" data-testid="district-panel">
      <div className="flex items-start gap-3 border-b border-slate-800 p-4">
        <Icon.Folder size={18} className="mt-1 shrink-0 text-sky-300" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-slate-400" title={d.path}>{d.path}</div>
          <div className="truncate text-[17px] font-semibold text-white" data-testid="district-name">{d.label}</div>
        </div>
        <button onClick={() => selectDistrict(null)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close district panel">
          <Icon.Close size={16} />
        </button>
      </div>
      <div className="stagger space-y-4 p-4">
        <div className="grid grid-cols-3 gap-3" style={{ ['--i' as string]: 0 }}>
          <Stat label="Files" value={<AnimatedNumber value={stats.files} />} />
          <Stat label="LOC" value={<AnimatedNumber value={stats.loc} format={formatNumber} />} />
          <Stat label="Avg risk" value={stats.avgRisk == null ? 'n/a' : <AnimatedNumber value={stats.avgRisk * 100} format={(v) => `${Math.round(v)}`} />} />
          <Stat label="Commits" value={<AnimatedNumber value={stats.commits} format={formatNumber} />} />
          <Stat label="Bug fixes" value={<AnimatedNumber value={stats.fixes} format={formatNumber} />} />
          <Stat label="Month" value={formatMonth(meta.months[monthIndex])} />
        </div>
        <div style={{ ['--i' as string]: 1 }}>
          <h3 className="panel-title mb-1.5">Growth (lines of code)</h3>
          <svg viewBox={`0 0 ${w} ${h}`} className="h-[46px] w-full" role="img" aria-label="District size over time">
            {pts.length > 1 && <path d={`M0,${h} L${pts.join(' L')} L${w},${h} Z`} fill="rgb(56 189 248 / 0.16)" />}
            {pts.length > 1 && <path d={`M${pts.join(' L')}`} pathLength={1} className="curve-path" fill="none" stroke="#38bdf8" strokeWidth={1.4} />}
            <line x1={monthIndex * step} x2={monthIndex * step} y1={0} y2={h} stroke="#f8fafc" strokeOpacity={0.55} strokeDasharray="2 2" />
          </svg>
        </div>
        <div style={{ ['--i' as string]: 2 }}>
          <h3 className="panel-title mb-1.5">Riskiest files here</h3>
          <ul className="space-y-0.5">
            {stats.members.slice(0, 6).map((i) => (
              <li key={i}>
                <button
                  onClick={() => select(i, true)}
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                  className="flex w-full justify-between gap-2 rounded-md px-2 py-1 text-left text-[12px] text-slate-300 hover:bg-slate-800 hover:text-white"
                >
                  <span className="truncate">{layout!.files.path[i].slice(d.path.length + 1)}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">{snapshot!.risk[i] >= 0 ? Math.round(snapshot!.risk[i] * 100) : 'n/a'}</span>
                </button>
              </li>
            ))}
            {stats.members.length === 0 && <li className="text-[12px] text-slate-500">No files in this district this month.</li>}
          </ul>
        </div>
      </div>
    </aside>
  )
}
