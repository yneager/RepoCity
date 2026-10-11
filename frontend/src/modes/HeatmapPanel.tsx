import { addMonths, cssGradientFromStops, formatMonth, HEAT_METRICS, HEAT_STOPS } from '../data/transforms'
import { useCity } from '../store'
import { Icon } from '../ui'

/** Heatmap mode: the city flattens into a map coloured by recent activity in a trailing window. */
export function HeatmapPanel() {
  const meta = useCity((s) => s.meta)
  const metric = useCity((s) => s.heatMetric)
  const setMetric = useCity((s) => s.setHeatMetric)
  const idx = useCity((s) => s.monthIndex)
  const lag = useCity((s) => s.lagSnapshot)
  if (!meta) return null
  const def = HEAT_METRICS.find((m) => m.id === metric)!
  const month = meta.months[idx]
  const from = lag ? addMonths(lag.month, 1) : meta.months[0]
  return (
    <div className="panel p-4 animate-slide-left" data-testid="heatmap-panel">
      <div className="flex items-center gap-2">
        <Icon.Flame size={16} className="text-orange-300" />
        <div className="text-[14px] font-semibold text-white">Activity heatmap</div>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-slate-400">
        The city flattens into a map. Colour shows how active each file was in the trailing window; the hottest files rise slightly.
        Play the timeline to watch activity move through the code base.
      </p>
      <div className="panel-title mt-4">Activity</div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {HEAT_METRICS.map((m) => (
          <button
            key={m.id}
            onClick={() => setMetric(m.id)}
            aria-pressed={metric === m.id}
            title={m.help}
            className={`rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] ${metric === m.id ? 'border-orange-300/50 bg-orange-400/10 text-white' : 'border-slate-700/60 text-slate-400 hover:text-slate-200'}`}
            data-testid={`heat-${m.id}`}
          >
            {m.label}
            <span className="block text-[10.5px] text-slate-500">last {m.window} months</span>
          </button>
        ))}
      </div>
      <div className="mt-4 h-2.5 overflow-hidden rounded-full" style={{ background: cssGradientFromStops(HEAT_STOPS) }} />
      <div className="mt-1 flex justify-between text-[11px] text-slate-400">
        <span>quiet</span>
        <span>most active</span>
      </div>
      <p className="mt-2 text-[11.5px] text-slate-500" data-testid="heat-window">
        Window: {formatMonth(from)} to {formatMonth(month)} ({def.label.toLowerCase()}).
      </p>
    </div>
  )
}
