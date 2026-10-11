import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type DemoRepo, type JobSummary } from '../api'
import { formatMonth, formatNumber, isValidRepoUrl } from '../data/transforms'
import { navigate } from '../router'
import { Icon, Logo, Skeleton, Spinner } from '../ui'

const EXAMPLES = ['https://github.com/pallets/click', 'https://github.com/jhy/jsoup', 'https://github.com/axios/axios']

export function Home() {
  const [demos, setDemos] = useState<DemoRepo[] | null>(null)
  const [demoError, setDemoError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [recent, setRecent] = useState<JobSummary[]>([])

  useEffect(() => {
    api.demos().then(setDemos).catch((e) => setDemoError(e instanceof Error ? e.message : String(e)))
    api.list().then((all) => setRecent(all.filter((j) => !j.demo))).catch(() => undefined)
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!isValidRepoUrl(url)) {
      setError('Enter a public https:// git URL, for example https://github.com/pallets/flask')
      return
    }
    setSubmitting(true)
    try {
      const job = await api.start(url.trim())
      navigate(job.status === 'done' ? { page: 'city', id: job.id } : { page: 'analyze', id: job.id })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the RepoCity backend. Is it running?')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page relative h-full overflow-y-auto scroll-thin">
      <HeroBackdrop />
      <div className="relative mx-auto flex max-w-5xl flex-col px-8 pb-16 pt-14">
        <header className="flex items-center gap-3">
          <Logo size={34} />
          <span className="text-xl font-semibold tracking-tight">RepoCity</span>
        </header>

        <section className="stagger mt-16 max-w-3xl">
          <h1 className="text-[44px] font-semibold leading-[1.08] tracking-tight text-white" style={{ ['--i' as string]: 1 }}>
            Every repository is a city.
            <br />
            <span className="bg-gradient-to-r from-emerald-300 via-amber-300 to-rose-400 bg-clip-text text-transparent">
              See where the bugs will be.
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-slate-300" style={{ ['--i' as string]: 3 }}>
            Files become buildings and directories become districts. Replay the whole history, then ask a model trained
            only on the past which files will need bug fixes in the next six months, and check its answer against what
            actually happened.
          </p>
        </section>

        <form onSubmit={submit} className="panel mt-10 max-w-3xl p-2 animate-rise focus-within:border-sky-400/50 focus-within:shadow-[0_0_0_4px_rgb(56_189_248/0.10)]" style={{ animationDelay: 'calc(var(--motion) * 320ms)' }} aria-label="Analyse a repository">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 px-3 text-slate-400">
              <Icon.City size={18} />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repository"
                className="h-11 w-full bg-transparent text-[15px] text-slate-100 placeholder:text-slate-500 focus:outline-none"
                aria-label="Public git repository URL"
                spellCheck={false}
                data-testid="repo-url"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="flex h-11 items-center gap-2 rounded-[10px] bg-sky-500 px-5 text-[14px] font-semibold text-slate-950 transition hover:bg-sky-400 disabled:opacity-60"
              data-testid="analyze-button"
            >
              {submitting ? <Spinner size={16} /> : null}
              Build city
            </button>
          </div>
        </form>
        {error ? (
          <p className="mt-3 flex items-center gap-2 text-[13.5px] text-rose-300" role="alert" data-testid="url-error">
            <Icon.Alert size={15} /> {error}
          </p>
        ) : (
          <p className="mt-3 text-[13px] text-slate-500">
            Try{' '}
            {EXAMPLES.map((ex, i) => (
              <span key={ex}>
                <button type="button" className="text-slate-300 underline-offset-2 hover:underline" onClick={() => setUrl(ex)}>
                  {ex.replace('https://github.com/', '')}
                </button>
                {i < EXAMPLES.length - 1 ? ', ' : ''}
              </span>
            ))}
            . Only public repositories over https are supported; nothing from the repository is ever executed.
          </p>
        )}

        <section className="mt-14">
          <div className="flex items-baseline justify-between">
            <h2 className="panel-title">Pre-analysed demo cities (work offline)</h2>
          </div>
          <div className="stagger mt-4 grid grid-cols-3 gap-4">
            {demos === null && !demoError &&
              [0, 1, 2].map((i) => (
                <div key={i} className="panel p-5">
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="mt-4 h-3 w-3/4" />
                  <Skeleton className="mt-2 h-3 w-2/3" />
                </div>
              ))}
            {demoError && (
              <div className="panel col-span-3 flex items-center gap-3 p-5 text-[14px] text-rose-200">
                <Icon.Alert /> The backend is not reachable ({demoError}). Start it with <code className="font-mono">docker compose up</code>.
              </div>
            )}
            {demos?.length === 0 && (
              <div className="panel col-span-3 p-5 text-[14px] text-slate-400">
                No demo cities found in <code className="font-mono">demo/cache</code>. Paste a URL above to analyse a repository.
              </div>
            )}
            {demos?.map((d, i) => (
              <button
                key={d.id}
                style={{ ['--i' as string]: i + 4 }}
                onClick={() => navigate({ page: 'city', id: d.id })}
                className="panel group p-5 text-left hover:-translate-y-1 hover:border-sky-400/40 hover:shadow-[0_18px_40px_-18px_rgb(56_189_248/0.35)]"
                data-testid={`demo-${d.id}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[16px] font-semibold text-white">{d.name}</span>
                  {d.language && <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">{d.language}</span>}
                </div>
                {d.description && <p className="mt-2 line-clamp-2 text-[13px] text-slate-400">{d.description}</p>}
                <div className="mt-4 flex gap-4 text-[12.5px] text-slate-400">
                  <span>
                    <b className="font-semibold text-slate-200">{formatNumber(d.nCommits)}</b> commits
                  </span>
                  <span>
                    <b className="font-semibold text-slate-200">{formatNumber(d.nFiles)}</b> files
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-slate-500">
                  {formatMonth(d.firstMonth)} to {formatMonth(d.lastMonth)}
                </div>
                <div className="mt-4 text-[12.5px] font-medium text-sky-300 opacity-80 group-hover:opacity-100">Enter city →</div>
              </button>
            ))}
          </div>
        </section>

        {recent.length > 0 && <RecentAnalyses jobs={recent} />}

        <section className="mt-14 grid grid-cols-3 gap-6 text-[13.5px] leading-relaxed text-slate-400">
          <Explainer title="Buildings = files">
            Footprint is lines of code. Height is churn, complexity or commits. Colour is predicted bug risk.
          </Explainer>
          <Explainer title="Time travel">
            Monthly snapshots replay the entire history. Red sparks show where SZZ says bugs were born.
          </Explainer>
          <Explainer title="Prediction vs Reality">
            Freeze the city at a cutoff, see the model's top-k risky files, then reveal which ones were really fixed.
          </Explainer>
        </section>
      </div>
    </div>
  )
}

function Explainer({ title, children }: { title: string; children: string }) {
  return (
    <div>
      <div className="mb-1.5 text-[14px] font-semibold text-slate-200">{title}</div>
      {children}
    </div>
  )
}

function HeroBackdrop() {
  // A tiny decorative skyline, generated deterministically.
  const bars = Array.from({ length: 64 }, (_, i) => {
    const h = 30 + ((i * 7919) % 97) * 1.6 + (i % 5) * 12
    const hue = (i * 37) % 100 < 70 ? '#1e293b' : (i * 13) % 3 === 0 ? '#7f1d1d' : '#14532d'
    return { x: i * 26, h, hue }
  })
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] overflow-hidden" aria-hidden>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_0%,rgba(56,189,248,0.16),transparent_55%),radial-gradient(ellipse_at_20%_10%,rgba(244,63,94,0.10),transparent_50%)]" />
      <svg className="absolute bottom-0 right-0 h-[180px] w-[1700px] opacity-35" viewBox="0 0 1700 260" preserveAspectRatio="xMaxYMax slice">
        {bars.map((b) => (
          <rect key={b.x} x={b.x} y={260 - b.h} width={20} height={b.h} rx={2} fill={b.hue} />
        ))}
      </svg>
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-ink-900 to-transparent" />
    </div>
  )
}

function RecentAnalyses({ jobs }: { jobs: JobSummary[] }) {
  return (
    <section className="mt-12 animate-fade-in" data-testid="recent-analyses">
      <h2 className="panel-title">Your analyses on this server</h2>
      <ul className="mt-3 divide-y divide-slate-800/80 overflow-hidden rounded-xl border border-slate-800/80">
        {jobs.slice(0, 8).map((j) => (
          <li key={j.id}>
            <button
              onClick={() => navigate(j.status === 'done' ? { page: 'city', id: j.id } : { page: 'analyze', id: j.id })}
              className="flex w-full items-center gap-4 bg-ink-850/60 px-4 py-2.5 text-left hover:bg-slate-800/70"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${j.status === 'done' ? 'bg-emerald-400' : j.status === 'error' ? 'bg-rose-400' : 'animate-pulse bg-sky-400'}`} />
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-slate-100">{j.name}</span>
              <span className="text-[12px] text-slate-500">
                {j.status === 'done' && j.nCommits != null ? `${formatNumber(j.nCommits)} commits · ${formatNumber(j.nFiles ?? 0)} files` : j.status === 'error' ? (j.error ?? 'failed') : `${Math.round(j.progress * 100)}%`}
              </span>
              <span className="text-[12px] text-sky-300/80">{j.status === 'done' ? 'Open →' : j.status === 'error' ? '' : 'Progress →'}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
