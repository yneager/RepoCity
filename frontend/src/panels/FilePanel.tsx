import { useEffect, useState, type ReactNode } from 'react'
import { api, type FileDetail, type Prediction } from '../api'
import { formatDate, formatMonth, formatNumber, rampColor, RISK_STOPS } from '../data/transforms'
import { useCity } from '../store'
import { Icon, Skeleton, Stat } from '../ui'

const predictionCache = new Map<string, Promise<Prediction>>()

function usePrediction(id: string | null, cutoff: string | null): Prediction | null {
  const [p, setP] = useState<Prediction | null>(null)
  useEffect(() => {
    setP(null)
    if (!id || !cutoff) return
    const key = `${id}/${cutoff}`
    if (!predictionCache.has(key)) predictionCache.set(key, api.prediction(id, cutoff))
    let live = true
    predictionCache
      .get(key)!
      .then((v) => live && setP(v))
      .catch(() => predictionCache.delete(key))
    return () => {
      live = false
    }
  }, [id, cutoff])
  return p
}

export function FilePanel() {
  const selected = useCity((s) => s.selected)
  const detail = useCity((s) => s.fileDetail)
  const loading = useCity((s) => s.fileLoading)
  const select = useCity((s) => s.select)
  const layout = useCity((s) => s.layout)
  const snapshot = useCity((s) => s.snapshot)
  const meta = useCity((s) => s.meta)
  const mode = useCity((s) => s.mode)
  const pvrPrediction = useCity((s) => s.prediction)
  const analysisId = useCity((s) => s.analysisId)
  const monthIndex = useCity((s) => s.monthIndex)
  const revealed = useCity((s) => s.revealed)
  const explorePrediction = usePrediction(mode === 'explore' ? analysisId : null, snapshot?.riskCutoff ?? null)
  const prediction = mode === 'pvr' ? pvrPrediction : explorePrediction

  if (selected == null || !layout || !snapshot || !meta) return null
  const path = layout.files.path[selected]
  const cut = path.lastIndexOf('/')
  const exists = snapshot.loc[selected] > 0
  const j = prediction ? prediction.files.indexOf(selected) : -1
  const riskPct = j >= 0 ? prediction!.riskPct[j] : null
  const shap = j >= 0 && prediction!.shap ? prediction!.shap[j] : null
  const actual = j >= 0 && prediction!.actual ? prediction!.actual[j] : null
  const currentMonth = meta.months[monthIndex]

  return (
    <aside className="panel pointer-events-auto flex max-h-full w-[360px] flex-col overflow-hidden animate-slide-in" data-testid="file-panel">
      <div className="flex items-start gap-3 border-b border-slate-800 p-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-slate-400" title={path}>{path.slice(0, cut + 1) || './'}</div>
          <div className="truncate text-[17px] font-semibold text-white" title={path} data-testid="file-panel-name">{path.slice(cut + 1)}</div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {riskPct != null && (
              <span
                className="rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-slate-950"
                style={{ background: `rgb(${rampColor(RISK_STOPS, riskPct).map((v) => Math.round(v * 255)).join(',')})` }}
              >
                risk {Math.round(riskPct * 100)}th percentile
              </span>
            )}
            {!exists && <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11.5px] text-slate-300">not present in {formatMonth(currentMonth)}</span>}
            {actual != null && mode === 'pvr' && revealed && (
              <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${actual ? 'bg-fuchsia-400/20 text-fuchsia-200' : 'bg-slate-800 text-slate-300'}`}>
                {actual ? 'was bug-fixed after cutoff' : 'no bug fix after cutoff'}
              </span>
            )}
          </div>
        </div>
        <button onClick={() => select(null)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close file panel" data-testid="file-panel-close">
          <Icon.Close size={16} />
        </button>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-3 gap-x-3 gap-y-3">
          <Stat label="LOC" value={formatNumber(snapshot.loc[selected])} />
          <Stat label="Complexity" value={formatNumber(snapshot.ccn[selected])} />
          <Stat label="Commits" value={formatNumber(snapshot.commits[selected])} />
          <Stat label="Churn" value={formatNumber(snapshot.churn[selected])} />
          <Stat label="Authors" value={snapshot.authors[selected]} />
          <Stat label="Bug fixes" value={snapshot.fixes[selected]} />
        </div>
        <div className="mt-1 text-[11px] text-slate-500">as of {formatMonth(currentMonth)}</div>

        <Section title="Why risky? (SHAP)">
          {shap ? <ShapBars rows={shap} labels={meta.featureLabels} /> : <p className="text-[12.5px] text-slate-500">{prediction ? 'No prediction for this file at this cutoff.' : 'No model prediction for this month yet.'}</p>}
          {prediction && <p className="mt-2 text-[11px] text-slate-500">Model trained on data up to {formatMonth(prediction.cutoff)}. Bars show each feature's push on the log-odds.</p>}
        </Section>

        {loading || !detail ? (
          <div className="mt-5 space-y-3" data-testid="file-panel-loading">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <FileHistory detail={detail} currentMonth={currentMonth} />
        )}
      </div>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="panel-title mb-2">{title}</h3>
      {children}
    </section>
  )
}

function ShapBars({ rows, labels }: { rows: [string, number | null, number | null][]; labels: Record<string, string> }) {
  const max = Math.max(0.01, ...rows.map((r) => Math.abs(r[2] ?? 0)))
  return (
    <div className="space-y-2" data-testid="shap-bars">
      {rows.map(([f, v, s]) => {
        const val = s ?? 0
        const w = (Math.abs(val) / max) * 50
        return (
          <div key={f}>
            <div className="flex justify-between text-[12px]">
              <span className="text-slate-300">{labels[f] ?? f}</span>
              <span className="tabular-nums text-slate-400">= {v == null ? 'n/a' : formatNumber(v)}</span>
            </div>
            <div className="relative mt-1 h-2 rounded-full bg-slate-800">
              <div className="absolute left-1/2 top-[-2px] h-3 w-px bg-slate-500" />
              <div
                className={`absolute top-0 h-2 rounded-full ${val >= 0 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                style={val >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
              />
            </div>
          </div>
        )
      })}
      <div className="flex justify-between text-[10.5px] text-slate-500">
        <span>← lowers risk</span>
        <span>raises risk →</span>
      </div>
    </div>
  )
}

function Sparkline({ months, values, current }: { months: string[]; values: number[]; current: string }) {
  const w = 320
  const h = 54
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 4 - (v / max) * (h - 8)).toFixed(1)}`)
  const ci = months.indexOf(current)
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[54px] w-full" data-testid="sparkline" role="img" aria-label="Commits per month">
      <path d={`M0,${h} L${pts.join(' L')} L${w},${h} Z`} fill="rgb(56 189 248 / 0.18)" />
      <path d={`M${pts.join(' L')}`} fill="none" stroke="#38bdf8" strokeWidth={1.4} />
      {ci >= 0 && <line x1={ci * step} x2={ci * step} y1={0} y2={h} stroke="#f8fafc" strokeOpacity={0.6} strokeDasharray="2 2" />}
    </svg>
  )
}

function FileHistory({ detail, currentMonth }: { detail: FileDetail; currentMonth: string }) {
  return (
    <>
      <Section title={`Change history (${detail.nChanges} commits)`}>
        <Sparkline months={detail.sparkline.months} values={detail.sparkline.commits} current={currentMonth} />
        <div className="flex justify-between text-[10.5px] text-slate-500">
          <span>{formatMonth(detail.sparkline.months[0])}</span>
          <span>{formatMonth(detail.sparkline.months.at(-1)!)}</span>
        </div>
        {detail.pathHistory.length > 1 && (
          <div className="mt-2 text-[11.5px] text-slate-400">
            Renamed: {detail.pathHistory.map((p) => p.path).join(' → ')}
          </div>
        )}
      </Section>

      <Section title={`Top authors (${detail.nAuthors})`}>
        <div className="space-y-1.5" data-testid="authors">
          {detail.authors.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-[12px]" title={`pseudonymous id ${a.id}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-700 text-[10.5px] font-semibold text-slate-200">{a.initials}</span>
              <span className="w-[70px] font-mono text-[10.5px] text-slate-500">#{a.id.slice(0, 6)}</span>
              <div className="h-1.5 flex-1 rounded-full bg-slate-800">
                <div className="h-1.5 rounded-full bg-sky-400/80" style={{ width: `${a.share * 100}%` }} />
              </div>
              <span className="w-10 text-right tabular-nums text-slate-400">{Math.round(a.share * 100)}%</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title={`Bug-fix commits (${detail.nFixes})`}>
        {detail.fixes.length === 0 ? (
          <p className="text-[12.5px] text-slate-500">No bug-fix commits touched this file.</p>
        ) : (
          <ul className="space-y-1.5" data-testid="fix-list">
            {detail.fixes.slice(0, 12).map((c) => (
              <li key={c.hash} className="text-[12px] leading-snug">
                <span className="font-mono text-[11px] text-rose-300">{c.hash.slice(0, 7)}</span>{' '}
                <span className="text-slate-500">{formatDate(c.time)}</span>
                <div className="truncate text-slate-300" title={c.subject}>{c.subject}</div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {detail.bugsBorn.length > 0 && (
        <Section title={`Bugs born here, per SZZ (${detail.nBugsBorn})`}>
          <ul className="space-y-1.5">
            {detail.bugsBorn.slice(0, 6).map((b) => (
              <li key={b.introHash + b.fix.hash} className="text-[12px] text-slate-400">
                <span className="font-mono text-[11px] text-amber-300">{b.introHash.slice(0, 7)}</span> {formatDate(b.introTime)} → fixed by{' '}
                <span className="font-mono text-[11px] text-rose-300">{b.fix.hash.slice(0, 7)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {detail.webUrl && (
        <a href={detail.webUrl} target="_blank" rel="noreferrer" className="mt-5 flex items-center justify-center gap-2 rounded-lg border border-slate-700 py-2 text-[13px] text-slate-200 hover:border-sky-400/50 hover:text-white" data-testid="remote-link">
          Open on {detail.webUrl.includes('gitlab') ? 'GitLab' : 'GitHub'} <Icon.External size={13} />
        </a>
      )}
    </>
  )
}
