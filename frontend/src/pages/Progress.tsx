import { useEffect, useRef, useState } from 'react'
import { api, type JobSummary, type ProgressEvent } from '../api'
import { navigate } from '../router'
import { AnimatedNumber, Icon, Logo, Spinner } from '../ui'

const STEPS: { id: string; label: string; help: string }[] = [
  { id: 'clone', label: 'Clone', help: 'Full history clone of the default branch' },
  { id: 'history', label: 'History', help: 'First-parent commits, churn, rename tracking' },
  { id: 'snapshots', label: 'Snapshots', help: 'Monthly file trees and static metrics' },
  { id: 'szz', label: 'SZZ', help: 'Bug-fix detection and bug-introducing commits' },
  { id: 'model', label: 'Model', help: 'LightGBM trained at every cutoff, SHAP explanations' },
  { id: 'layout', label: 'Layout', help: 'Stable squarified treemap and export' },
]

export function Progress({ id }: { id: string }) {
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const [job, setJob] = useState<JobSummary | null>(null)
  const [lost, setLost] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let closed = false
    api.status(id).then(setJob).catch(() => setLost(true))
    const close = api.events(
      id,
      (ev) => {
        setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev]))
        if (ev.kind === 'done' && !closed) setTimeout(() => navigate({ page: 'city', id }), 700)
        if (ev.kind === 'error' || ev.kind === 'done') api.status(id).then(setJob).catch(() => undefined)
      },
      () => setLost(true),
    )
    return () => {
      closed = true
      close()
    }
  }, [id])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [events])

  const last = events.at(-1)
  const progress = last?.progress ?? 0
  const failed = last?.kind === 'error' || job?.status === 'error'
  const currentStep = last?.step ?? 'clone'
  const doneSteps = new Set(STEPS.slice(0, STEPS.findIndex((s) => s.id === currentStep)).map((s) => s.id))
  if (last?.kind === 'done') STEPS.forEach((s) => doneSteps.add(s.id))
  const warnings = events.filter((e) => e.kind === 'warning')

  return (
    <div className="page flex h-full flex-col items-center overflow-y-auto px-8 py-14">
      <div className="flex w-full max-w-3xl items-center gap-3">
        <button onClick={() => navigate({ page: 'home' })} className="flex items-center gap-3" aria-label="Back to home">
          <Logo size={30} />
          <span className="text-lg font-semibold">RepoCity</span>
        </button>
      </div>
      <div className="panel mt-10 w-full max-w-3xl p-7 animate-fade-in" data-testid="progress-panel">
        <div className="flex items-center justify-between">
          <div>
            <div className="panel-title">Building city</div>
            <div className="mt-1 text-[20px] font-semibold text-white">{job?.name ?? id}</div>
            {job?.url && <div className="text-[13px] text-slate-400">{job.url}</div>}
          </div>
          <div className="flex items-center gap-4">
            {!failed && last?.kind !== 'done' && (
              <button
                onClick={() => {
                  setCancelling(true)
                  api.cancel(id).catch(() => setCancelling(false))
                }}
                disabled={cancelling}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-[12.5px] text-slate-300 hover:border-rose-400/60 hover:text-rose-200 disabled:opacity-50"
                data-testid="cancel-analysis"
              >
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
            <AnimatedNumber value={Math.round(progress * 100)} format={(v) => `${Math.round(v)}%`} className="text-[28px] font-semibold tabular-nums text-sky-300" />
          </div>
        </div>
        <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div
            className={`relative h-full overflow-hidden rounded-full transition-[width] duration-[1200ms] ease-out ${failed ? 'bg-rose-500' : 'bg-gradient-to-r from-sky-400 to-emerald-400'}`}
            style={{ width: `${Math.max(2, progress * 100)}%` }}
          />
        </div>
        <ol className="mt-6 grid grid-cols-6 gap-2">
          {STEPS.map((s) => {
            const active = s.id === currentStep && !failed && last?.kind !== 'done'
            const done = doneSteps.has(s.id)
            return (
              <li key={s.id} className={`rounded-xl border px-3 py-2.5 ${active ? 'border-sky-400/50 bg-sky-400/10' : done ? 'border-emerald-400/30 bg-emerald-400/5' : 'border-slate-700/60'}`} title={s.help}>
                <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                  {done ? <Icon.Check size={14} className="text-emerald-300" /> : active ? <Spinner size={13} /> : <span className="h-3.5 w-3.5 rounded-full border border-slate-600" />}
                  <span className={done || active ? 'text-slate-100' : 'text-slate-500'}>{s.label}</span>
                </div>
              </li>
            )
          })}
        </ol>
        {warnings.map((w) => (
          <div key={w.seq} className="mt-4 flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[13px] text-amber-200">
            <Icon.Alert size={15} /> {w.message}
          </div>
        ))}
        {failed && (
          <div className="mt-5 rounded-xl border border-rose-400/30 bg-rose-500/10 p-4" role="alert" data-testid="analysis-error">
            <div className="flex items-center gap-2 font-semibold text-rose-200">
              <Icon.Alert size={16} /> Analysis failed
            </div>
            <p className="mt-1 text-[13.5px] text-rose-100/80">{job?.error ?? last?.message}</p>
            <button onClick={() => navigate({ page: 'home' })} className="mt-3 rounded-lg bg-slate-800 px-3 py-1.5 text-[13px] hover:bg-slate-700">
              Back to start
            </button>
          </div>
        )}
        {lost && !failed && last?.kind !== 'done' && (
          <p className="mt-4 text-[13px] text-amber-200">Lost connection to the progress stream. The analysis keeps running; refresh to reconnect.</p>
        )}
        <div ref={logRef} className="scroll-thin mt-6 h-56 overflow-y-auto rounded-xl bg-ink-950/70 p-3 font-mono text-[12px] leading-relaxed text-slate-400" data-testid="progress-log">
          {events.length === 0 && <div className="text-slate-500">Waiting for the worker…</div>}
          {events.map((e) => (
            <div key={e.seq} className={e.kind === 'error' ? 'text-rose-300' : e.kind === 'warning' ? 'text-amber-300' : e.kind === 'done' ? 'text-emerald-300' : ''}>
              <span className="text-slate-600">{new Date(e.time * 1000).toLocaleTimeString()}</span>{' '}
              <span className="text-sky-300/80">[{e.step}]</span> {e.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
