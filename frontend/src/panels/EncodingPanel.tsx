import { COLOR_MODES, cssGradient, formatMonth, formatNumber, HEIGHT_MODES, type ColorMode } from '../data/transforms'
import { useCity } from '../store'
import { AnimatedNumber, Icon, Stat } from '../ui'
import { Toggle } from './SettingsMenu'

export function EncodingPanel() {
  const heightMode = useCity((s) => s.heightMode)
  const colorMode = useCity((s) => s.colorMode)
  const setHeightMode = useCity((s) => s.setHeightMode)
  const setColorMode = useCity((s) => s.setColorMode)
  return (
    <div className="panel p-4 animate-slide-left" data-testid="encoding-panel">
      <div className="panel-title">Height</div>
      <div className="seg mt-2 w-full" role="group" aria-label="Height encoding">
        {HEIGHT_MODES.map((m) => (
          <button key={m.id} aria-pressed={heightMode === m.id} onClick={() => setHeightMode(m.id)} title={`${m.help} (${m.key})`} className="flex-1" data-testid={`height-${m.id}`}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="panel-title mt-4">Colour</div>
      <div className="mt-2 grid grid-cols-2 gap-1.5" role="group" aria-label="Colour encoding">
        {COLOR_MODES.map((m) => (
          <button
            key={m.id}
            aria-pressed={colorMode === m.id}
            onClick={() => setColorMode(m.id)}
            title={`${m.help} (${m.key})`}
            className={`rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] ${colorMode === m.id ? 'border-sky-400/50 bg-sky-400/10 text-white' : 'border-slate-700/60 text-slate-400 hover:border-slate-500 hover:text-slate-200'}`}
            data-testid={`color-${m.id}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <Legend mode={colorMode} />
      <Filters />
    </div>
  )
}

function Filters() {
  const pathFilter = useCity((s) => s.pathFilter)
  const setPathFilter = useCity((s) => s.setPathFilter)
  const hideTests = useCity((s) => s.hideTests)
  const setHideTests = useCity((s) => s.setHideTests)
  return (
    <div className="mt-4 border-t border-slate-800 pt-3.5">
      <div className="panel-title flex items-center gap-1.5">
        <Icon.Filter size={12} /> Filter
      </div>
      <div className="mt-2 flex h-8 items-center gap-2 rounded-lg border border-slate-700/70 bg-slate-900/70 px-2.5 focus-within:border-sky-400/60">
        <input
          value={pathFilter}
          onChange={(e) => setPathFilter(e.target.value)}
          placeholder="Highlight paths containing…"
          className="w-full bg-transparent text-[12.5px] text-slate-100 placeholder:text-slate-500 focus:outline-none"
          aria-label="Path filter"
          data-testid="path-filter"
        />
        {pathFilter && (
          <button onClick={() => setPathFilter('')} className="text-slate-500 hover:text-white" aria-label="Clear filter">
            <Icon.Close size={13} />
          </button>
        )}
      </div>
      <div className="mt-2.5">
        <Toggle label="Hide test files" checked={hideTests} onChange={setHideTests} testid="toggle-hide-tests" />
      </div>
    </div>
  )
}

export function Legend({ mode }: { mode: ColorMode }) {
  const meta = useCity((s) => s.meta)
  const snapshot = useCity((s) => s.snapshot)
  const labels: Record<ColorMode, [string, string]> = {
    risk: ['low risk', 'high risk'],
    authors: ['1 author', `${meta?.maxima.authors ?? ''} authors`],
    age: ['new', `${Math.round((meta?.maxima.age ?? 0) / 12)} years`],
    bugs: ['no fixes', `${meta?.maxima.fixes ?? ''} fixes`],
  }
  return (
    <div className="mt-4" data-testid="legend">
      <div className="relative h-2.5 overflow-hidden rounded-full">
        {/* cross-fade between ramps when the colour mode changes */}
        <div key={mode} className="absolute inset-0 animate-fade-in" style={{ background: cssGradient(mode) }} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-slate-400">
        <span>{labels[mode][0]}</span>
        <span>{labels[mode][1]}</span>
      </div>
      {mode === 'risk' && (
        <p className="mt-2 text-[11.5px] leading-snug text-slate-500">
          Risk percentile from LightGBM trained only on data up to{' '}
          <span className="text-slate-300">{snapshot?.riskCutoff ? formatMonth(snapshot.riskCutoff) : 'n/a'}</span>.
          <span className="ml-1 inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-slate-500" /> no prediction yet
          </span>
        </p>
      )}
      <p className="mt-2 text-[11.5px] leading-snug text-slate-500">Footprint = lines of code. Districts = directories (click one).</p>
    </div>
  )
}

export function StatsPanel() {
  const meta = useCity((s) => s.meta)
  const stats = useCity((s) => s.monthStats)
  const idx = useCity((s) => s.monthIndex)
  const st = stats[idx]
  if (!meta || !st) return null
  return (
    <div className="panel grid grid-cols-2 gap-x-4 gap-y-3 p-4 animate-slide-left" data-testid="stats-panel">
      <Stat label="Files" value={<AnimatedNumber value={st.files} testid="stat-files" />} />
      <Stat label="Lines of code" value={<AnimatedNumber value={st.loc} format={formatNumber} />} />
      <Stat label="Commits so far" value={<AnimatedNumber value={st.commits} format={formatNumber} />} sub={`of ${formatNumber(meta.nCommits)}`} />
      <Stat
        label="Bug-fix commits"
        value={<AnimatedNumber value={st.fixes} format={formatNumber} />}
        sub={`${Math.round((100 * st.fixes) / Math.max(1, st.commits))}% of commits`}
      />
    </div>
  )
}
