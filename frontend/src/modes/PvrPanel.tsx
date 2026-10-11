import { useMemo } from 'react'
import type { MetricSet, Prediction } from '../api'
import { addMonths, cssGradient, curveAt, effortCurve, formatMonth, optimalOrder, scoreCard, type CurvePoint } from '../data/transforms'
import { Toggle } from '../panels/SettingsMenu'
import { useCity } from '../store'
import { AnimatedNumber, Icon, Skeleton, Spinner } from '../ui'

const KS = [10, 20, 50]

export function PvrPanel() {
  const meta = useCity((s) => s.meta)
  const cutoff = useCity((s) => s.pvrCutoff)
  const k = useCity((s) => s.pvrK)
  const prediction = useCity((s) => s.prediction)
  const loading = useCity((s) => s.predictionLoading)
  const revealed = useCity((s) => s.revealed)
  const showHotspot = useCity((s) => s.showHotspotTopK)
  const setCutoff = useCity((s) => s.setPvrCutoff)
  const step = useCity((s) => s.stepPvrCutoff)
  const setK = useCity((s) => s.setPvrK)
  const setRevealed = useCity((s) => s.setRevealed)
  const setShowHotspot = useCity((s) => s.setShowHotspotTopK)
  const cutoffs = useMemo(() => meta?.cutoffs.filter((c) => c.hasLabels && c.trained) ?? [], [meta])
  if (!meta) return null
  const pos = cutoffs.findIndex((c) => c.cutoff === cutoff)

  return (
    <div className="panel p-4 animate-slide-left" data-testid="pvr-panel">
      <div className="flex items-center gap-2">
        <Icon.Target size={16} className="text-amber-300" />
        <div className="text-[14px] font-semibold text-white">Prediction vs Reality</div>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-slate-400">
        The city is frozen at the cutoff. A model trained only on data up to then colours it and outlines its top-{k} riskiest files.
        Reveal shows which files really got bug fixes in the next {meta.horizonMonths} months.
      </p>

      <div className="mt-4">
        <span className="panel-title">Cutoff</span>
        <div className="mt-1.5 flex items-center gap-1.5">
          <button onClick={() => step(-1)} disabled={pos <= 0} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:border-sky-400/50 hover:text-white disabled:opacity-30" aria-label="Previous cutoff" title="Previous cutoff ([)" data-testid="pvr-prev">
            <Icon.ChevronLeft size={14} />
          </button>
          <select
            value={cutoff ?? ''}
            onChange={(e) => void setCutoff(e.target.value)}
            className="block min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-[13px] text-slate-100"
            data-testid="pvr-cutoff"
          >
            {cutoffs.map((c) => (
              <option key={c.cutoff} value={c.cutoff}>
                {formatMonth(c.cutoff)}
                {c.isEvalCutoff ? '  ★ evaluation' : ''}
              </option>
            ))}
          </select>
          <button onClick={() => step(1)} disabled={pos >= cutoffs.length - 1} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:border-sky-400/50 hover:text-white disabled:opacity-30" aria-label="Next cutoff" title="Next cutoff (])" data-testid="pvr-next">
            <Icon.ChevronRight size={14} />
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="panel-title">Top-k</span>
        <div className="seg" role="group" aria-label="k">
          {KS.map((v) => (
            <button key={v} aria-pressed={k === v} onClick={() => setK(v)} data-testid={`pvr-k-${v}`}>
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <Toggle label="Also outline the hotspot baseline's top-k (cyan)" checked={showHotspot} onChange={setShowHotspot} testid="toggle-hotspot" />
      </div>

      {loading || !prediction ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div key={prediction.cutoff} className="animate-fade-in">
          <div className="mt-4 rounded-lg bg-slate-900/70 px-3 py-2 text-[11.5px] leading-snug text-slate-400">
            Trained on {prediction.nTrain} file-windows ({prediction.nTrainPos} fixed) from{' '}
            {prediction.trainMonths.map(formatMonth).join(', ')}. Window under test: {formatMonth(addMonths(prediction.cutoff, 1))} to{' '}
            {formatMonth(prediction.horizonEnd)}.
          </div>
          {!revealed ? (
            <button
              onClick={() => setRevealed(true)}
              className="group relative mt-4 flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-amber-400 to-rose-400 py-3 text-[14px] font-bold text-slate-950 shadow-lg shadow-rose-500/20 hover:shadow-rose-500/40 hover:brightness-110"
              data-testid="reveal-button"
              title="Reveal (V)"
            >
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/35 to-transparent transition-transform duration-[1400ms] ease-out group-hover:translate-x-full" />
              <Icon.Eye size={17} /> Reveal reality
            </button>
          ) : (
            <ScoreCardView prediction={prediction} k={k} onHide={() => setRevealed(false)} />
          )}
        </div>
      )}
      {loading && (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-slate-400">
          <Spinner size={12} /> loading prediction
        </div>
      )}
      <PvrLegend revealed={revealed} showHotspot={showHotspot} />
    </div>
  )
}

const pct = (v: number | null | undefined) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`)
const num = (v: number | null | undefined) => (v == null ? 'n/a' : v.toFixed(2))

function ScoreCardView({ prediction, k, onHide }: { prediction: Prediction; k: number; onHide: () => void }) {
  const card = scoreCard(prediction, k)
  const model = prediction.metrics[prediction.model] as MetricSet | undefined
  const hot = prediction.metrics.hotspot as MetricSet | undefined
  const rows: { label: string; a: number | null | undefined; b: number | null | undefined; fmt: (v: number | null | undefined) => string; testid: string }[] = [
    { label: `Precision@${card.k}`, a: card.precision, b: card.hotspotPrecision, fmt: pct, testid: 'precision' },
    { label: 'Recall@20%LOC', a: model?.recall_20loc, b: hot?.recall_20loc, fmt: pct, testid: 'recall' },
    { label: 'Recall@20%LOC, risk/LOC', a: model?.recall_20loc_ea, b: hot?.recall_20loc_ea, fmt: pct, testid: 'recall-ea' },
    { label: 'Popt, risk/LOC', a: model?.popt_ea, b: hot?.popt_ea, fmt: num, testid: 'popt-ea' },
    { label: 'ROC-AUC', a: model?.roc_auc, b: hot?.roc_auc, fmt: num, testid: 'auc' },
  ]
  return (
    <div className="mt-4" data-testid="score-card">
      <div className="flex items-baseline justify-between animate-[pop_var(--dur)_var(--ease-out)_both]">
        <div className="text-[13px] text-slate-300">
          <AnimatedNumber value={card.hits} duration={1.4} className="text-[24px] font-semibold text-white" testid="hits-value" /> of top-{card.k} were fixed
        </div>
        <button onClick={onHide} className="text-[11.5px] text-slate-500 hover:text-slate-300">hide</button>
      </div>
      <div className="text-[11.5px] text-slate-500">
        Hotspot baseline: <span className="text-slate-300">{card.hotspotHits}</span> of top-{card.k} · {card.positives} of {prediction.files.length} files fixed in the window
      </div>
      <table className="mt-3 w-full text-[12.5px]">
        <thead>
          <tr className="text-[11px] text-slate-500">
            <th className="pb-1 text-left font-medium">Metric</th>
            <th className="pb-1 pl-2 text-right font-medium">{prediction.model === 'lightgbm' ? 'LightGBM' : 'Hotspot*'}</th>
            <th className="pb-1 pl-3 text-right font-medium">Hotspot</th>
          </tr>
        </thead>
        <tbody className="stagger">
          {rows.map((r, i) => {
            const better = (r.a ?? 0) - (r.b ?? 0)
            return (
              <tr key={r.label} className="border-t border-slate-800" style={{ ['--i' as string]: i + 1 }}>
                <td className="py-1.5 text-slate-300">{r.label}</td>
                <td className={`py-1.5 text-right tabular-nums ${better > 0 ? 'font-semibold text-emerald-300' : 'text-slate-200'}`} data-testid={`card-model-${r.testid}`} data-value={r.a ?? ''}>{r.fmt(r.a)}</td>
                <td className={`py-1.5 pl-3 text-right tabular-nums ${better < 0 ? 'font-semibold text-emerald-300' : 'text-slate-400'}`} data-testid={`card-hotspot-${r.testid}`} data-value={r.b ?? ''}>{r.fmt(r.b)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <EffortCurve prediction={prediction} />
    </div>
  )
}

/** Cumulative % of fixed files found vs % of code read, for several reading orders. */
function EffortCurve({ prediction }: { prediction: Prediction }) {
  const snapshot = useCity((s) => s.snapshot)
  const curves = useMemo(() => {
    if (!snapshot || !prediction.actual || !prediction.rankModelEa) return null
    const loc = prediction.files.map((b) => snapshot.loc[b])
    const actual = prediction.actual
    return {
      model: effortCurve(prediction.rankModel, loc, actual),
      modelEa: effortCurve(prediction.rankModelEa, loc, actual),
      hotspot: effortCurve(prediction.rankHotspot, loc, actual),
      optimal: effortCurve(optimalOrder(loc, actual), loc, actual),
    }
  }, [snapshot, prediction])
  if (!curves) return null
  const W = 240
  const H = 150
  const P = 22
  const toPath = (c: CurvePoint[]) => `M${c.map(([x, y]) => `${(P + x * (W - P - 6)).toFixed(1)},${(H - P - y * (H - P - 6)).toFixed(1)}`).join(' L')}`
  const series: { key: keyof typeof curves; label: string; color: string; dash?: string; width: number }[] = [
    { key: 'optimal', label: 'optimal', color: '#64748b', dash: '3 3', width: 1.2 },
    { key: 'hotspot', label: 'hotspot', color: '#22d3ee', width: 1.6 },
    { key: 'model', label: 'model, by risk', color: '#fbbf24', width: 1.6 },
    { key: 'modelEa', label: 'model, by risk/LOC', color: '#4ade80', width: 2.2 },
  ]
  const x20 = P + 0.2 * (W - P - 6)
  return (
    <div className="mt-4" data-testid="effort-curve">
      <h3 className="panel-title mb-1">Effort curve</h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Share of fixed files found against share of code read">
        <line x1={P} y1={H - P} x2={W - 6} y2={H - P} stroke="#334155" />
        <line x1={P} y1={6} x2={P} y2={H - P} stroke="#334155" />
        <line x1={P} y1={H - P} x2={W - 6} y2={6} stroke="#475569" strokeDasharray="2 3" />
        <line x1={x20} y1={6} x2={x20} y2={H - P} stroke="#f8fafc" strokeOpacity={0.35} strokeDasharray="2 2" />
        <text x={x20 + 3} y={14} fontSize={8} fill="#94a3b8">20% of code</text>
        {series.map((s, i) => (
          <path
            key={s.key}
            d={toPath(curves[s.key])}
            pathLength={1}
            className={s.dash ? undefined : 'curve-path'}
            style={s.dash ? undefined : { animationDelay: `calc(var(--motion) * ${200 + i * 220}ms)` }}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width}
            strokeDasharray={s.dash}
            strokeLinejoin="round"
          />
        ))}
        <text x={P} y={H - 6} fontSize={8} fill="#94a3b8">0%</text>
        <text x={W - 6} y={H - 6} fontSize={8} fill="#94a3b8" textAnchor="end">100% of LOC read</text>
        <text x={4} y={10} fontSize={8} fill="#94a3b8">100%</text>
      </svg>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px]">
        {series.map((s) => (
          <div key={s.key} className="flex items-center justify-between gap-2 text-slate-400">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3" style={{ background: s.color }} /> {s.label}
            </span>
            <span className="tabular-nums text-slate-300">{Math.round(curveAt(curves[s.key], 0.2) * 100)}%</span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-slate-500">
        Each line shows how many of the later-fixed files you would have read, against how much code you had to read. Numbers = recall at 20% of code.
      </p>
    </div>
  )
}

function PvrLegend({ revealed, showHotspot }: { revealed: boolean; showHotspot: boolean }) {
  return (
    <div className="mt-4 space-y-1.5 text-[11.5px] text-slate-400">
      <div className="h-2 rounded-full" style={{ background: cssGradient('risk') }} />
      <div className="flex justify-between text-[10.5px]">
        <span>low predicted risk</span>
        <span>high</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-block h-3 w-3 rounded-sm border-2 border-amber-400" /> model's top-k
      </div>
      {showHotspot && (
        <div className="flex items-center gap-2 animate-fade-in">
          <span className="inline-block h-3 w-3 rounded-sm border-2 border-cyan-400" /> hotspot's top-k
        </div>
      )}
      {revealed && (
        <>
          <div className="flex items-center gap-2 animate-fade-in">
            <span className="inline-block h-3 w-3 rotate-45 bg-green-400" /> fixed and predicted (hit)
          </div>
          <div className="flex items-center gap-2 animate-fade-in">
            <span className="inline-block h-3 w-3 rotate-45 bg-fuchsia-300" /> fixed but missed
          </div>
        </>
      )}
    </div>
  )
}
