import { useMemo } from 'react'
import type { MetricSet, Prediction } from '../api'
import { addMonths, cssGradient, formatMonth, scoreCard } from '../data/transforms'
import { useCity } from '../store'
import { Icon, Skeleton, Spinner } from '../ui'

const KS = [10, 20, 50]

export function PvrPanel() {
  const meta = useCity((s) => s.meta)
  const cutoff = useCity((s) => s.pvrCutoff)
  const k = useCity((s) => s.pvrK)
  const prediction = useCity((s) => s.prediction)
  const loading = useCity((s) => s.predictionLoading)
  const revealed = useCity((s) => s.revealed)
  const setCutoff = useCity((s) => s.setPvrCutoff)
  const setK = useCity((s) => s.setPvrK)
  const setRevealed = useCity((s) => s.setRevealed)
  const cutoffs = useMemo(() => meta?.cutoffs.filter((c) => c.hasLabels && c.trained) ?? [], [meta])
  if (!meta) return null

  return (
    <div className="panel p-4" data-testid="pvr-panel">
      <div className="flex items-center gap-2">
        <Icon.Target size={16} className="text-amber-300" />
        <div className="text-[14px] font-semibold text-white">Prediction vs Reality</div>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-slate-400">
        The city is frozen at the cutoff. A model trained only on data up to then colours it and outlines its top-{k} riskiest files.
        Reveal shows which files really got bug fixes in the next {meta.horizonMonths} months.
      </p>

      <label className="mt-4 block">
        <span className="panel-title">Cutoff</span>
        <select
          value={cutoff ?? ''}
          onChange={(e) => void setCutoff(e.target.value)}
          className="mt-1.5 block w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-[13px] text-slate-100"
          data-testid="pvr-cutoff"
        >
          {cutoffs.map((c) => (
            <option key={c.cutoff} value={c.cutoff}>
              {formatMonth(c.cutoff)}
              {c.isEvalCutoff ? '  (evaluation cutoff)' : ''}
            </option>
          ))}
        </select>
      </label>
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

      {loading || !prediction ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <>
          <div className="mt-4 rounded-lg bg-slate-900/70 px-3 py-2 text-[11.5px] leading-snug text-slate-400">
            Trained on {prediction.nTrain} file-windows ({prediction.nTrainPos} fixed) from{' '}
            {prediction.trainMonths.map(formatMonth).join(', ')}. Window under test: {formatMonth(addMonths(prediction.cutoff, 1))} to{' '}
            {formatMonth(prediction.horizonEnd)}.
          </div>
          {!revealed ? (
            <button
              onClick={() => setRevealed(true)}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-rose-400 py-3 text-[14px] font-bold text-slate-950 shadow-lg shadow-rose-500/20 transition hover:brightness-110"
              data-testid="reveal-button"
            >
              <Icon.Eye size={17} /> Reveal reality
            </button>
          ) : (
            <ScoreCardView prediction={prediction} k={k} onHide={() => setRevealed(false)} />
          )}
          <PvrLegend revealed={revealed} />
        </>
      )}
      {loading && (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-slate-400">
          <Spinner size={12} /> loading prediction
        </div>
      )}
    </div>
  )
}

const pct = (v: number | null | undefined) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`)
const num = (v: number | null | undefined) => (v == null ? 'n/a' : v.toFixed(2))

function ScoreCardView({ prediction, k, onHide }: { prediction: Prediction; k: number; onHide: () => void }) {
  const card = scoreCard(prediction, k)
  const model = prediction.metrics[prediction.model] as MetricSet | undefined
  const hot = prediction.metrics.hotspot as MetricSet | undefined
  const rows: { label: string; a: string; b: string; better: number; testid: string }[] = [
    { label: `Hits@${card.k}`, a: `${card.hits}`, b: `${card.hotspotHits}`, better: card.hits - card.hotspotHits, testid: 'hits' },
    { label: `Precision@${card.k}`, a: pct(card.precision), b: pct(card.hotspotPrecision), better: card.precision - card.hotspotPrecision, testid: 'precision' },
    { label: 'Recall@20%LOC', a: pct(model?.recall_20loc), b: pct(hot?.recall_20loc), better: (model?.recall_20loc ?? 0) - (hot?.recall_20loc ?? 0), testid: 'recall' },
    { label: 'Recall@20%LOC, risk/LOC', a: pct(model?.recall_20loc_ea), b: pct(hot?.recall_20loc_ea), better: (model?.recall_20loc_ea ?? 0) - (hot?.recall_20loc_ea ?? 0), testid: 'recall-ea' },
    { label: 'Popt, risk/LOC', a: num(model?.popt_ea), b: num(hot?.popt_ea), better: (model?.popt_ea ?? 0) - (hot?.popt_ea ?? 0), testid: 'popt-ea' },
    { label: 'ROC-AUC', a: num(model?.roc_auc), b: num(hot?.roc_auc), better: (model?.roc_auc ?? 0) - (hot?.roc_auc ?? 0), testid: 'auc' },
  ]
  return (
    <div className="mt-4 animate-fade-in" data-testid="score-card">
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] text-slate-300">
          <b className="text-[22px] font-semibold text-white" data-testid="hits-value">{card.hits}</b> of top-{card.k} were fixed
        </div>
        <button onClick={onHide} className="text-[11.5px] text-slate-500 hover:text-slate-300">hide</button>
      </div>
      <div className="text-[11.5px] text-slate-500">{card.positives} of {prediction.files.length} files received a bug fix in the window</div>
      <table className="mt-3 w-full text-[12.5px]">
        <thead>
          <tr className="text-[11px] text-slate-500">
            <th className="pb-1 text-left font-medium">Metric</th>
            <th className="pb-1 text-right font-medium">{prediction.model === 'lightgbm' ? 'LightGBM' : 'Hotspot*'}</th>
            <th className="pb-1 text-right font-medium">Hotspot</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-slate-800">
              <td className="py-1.5 text-slate-300">{r.label}</td>
              <td className={`py-1.5 text-right tabular-nums ${r.better > 0 ? 'font-semibold text-emerald-300' : 'text-slate-200'}`} data-testid={`card-model-${r.testid}`}>{r.a}</td>
              <td className={`py-1.5 text-right tabular-nums ${r.better < 0 ? 'font-semibold text-emerald-300' : 'text-slate-400'}`} data-testid={`card-hotspot-${r.testid}`}>{r.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10.5px] leading-snug text-slate-500">
        Recall@20%LOC: share of fixed files found when reading top-ranked files until 20% of all code is read; "risk/LOC" ranks by
        risk per line instead. Same numbers as the backend evaluation (E1).
      </p>
    </div>
  )
}

function PvrLegend({ revealed }: { revealed: boolean }) {
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
      {revealed && (
        <>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rotate-45 bg-green-400" /> fixed and predicted (hit)
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rotate-45 bg-fuchsia-400" /> fixed but missed
          </div>
        </>
      )}
    </div>
  )
}
