import { useEffect } from 'react'
import { downloadScreenshot } from '../city/capture'
import { CityScene } from '../city/CityScene'
import { HeatmapPanel } from '../modes/HeatmapPanel'
import { PvrPanel } from '../modes/PvrPanel'
import { useSettings } from '../motion'
import { DistrictPanel } from '../panels/DistrictPanel'
import { EncodingPanel, StatsPanel } from '../panels/EncodingPanel'
import { FilePanel } from '../panels/FilePanel'
import { Leaderboard } from '../panels/Leaderboard'
import { Minimap } from '../panels/Minimap'
import { screenshotName, ShortcutsOverlay, useShortcuts } from '../panels/ShortcutsOverlay'
import { Tooltip } from '../panels/Tooltip'
import { TopBar } from '../panels/TopBar'
import { navigate } from '../router'
import { useCity } from '../store'
import { Timeline } from '../timeline/Timeline'
import { Icon, Logo, Skeleton } from '../ui'
import { useUrlState } from '../urlState'

export function CityView({ id }: { id: string }) {
  const load = useCity((s) => s.load)
  const meta = useCity((s) => s.meta)
  const layout = useCity((s) => s.layout)
  const snapshot = useCity((s) => s.snapshot)
  const error = useCity((s) => s.error)
  const loading = useCity((s) => s.loading)
  const mode = useCity((s) => s.mode)
  const selected = useCity((s) => s.selected)
  const selectedDistrict = useCity((s) => s.selectedDistrict)
  useShortcuts()
  useUrlState(id)

  useEffect(() => {
    void load(id)
  }, [id, load])

  if (error && !meta) return <CityError message={error} />
  const ready = meta && layout && snapshot && !loading

  return (
    <div className="page relative flex h-full flex-col">
      <TopBar />
      <main className="relative flex-1 overflow-hidden" data-testid="city-view" data-ready={ready ? 'true' : 'false'}>
        {ready ? <CityScene layout={layout} meta={meta} snapshot={snapshot} /> : <CityLoading />}
        {ready && (
          <div className="pointer-events-none absolute inset-0 flex gap-3 p-3">
            <div className="pointer-events-auto flex w-[272px] shrink-0 flex-col gap-3 overflow-y-auto scroll-thin pb-1" key={mode}>
              {mode === 'explore' && (
                <>
                  <EncodingPanel />
                  <StatsPanel />
                  <Leaderboard />
                </>
              )}
              {mode === 'heatmap' && (
                <>
                  <HeatmapPanel />
                  <StatsPanel />
                  <Leaderboard />
                </>
              )}
              {mode === 'pvr' && <PvrPanel />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-between">
              <ViewToolbar />
              {mode !== 'pvr' && <Timeline />}
            </div>
            <div className="flex max-h-full min-h-0 shrink-0 flex-col items-end gap-3">
              <div className="flex min-h-0 flex-1 flex-col">
                {selected != null ? <FilePanel /> : selectedDistrict != null ? <DistrictPanel /> : null}
              </div>
              <Minimap layout={layout} />
            </div>
          </div>
        )}
        {ready && meta.warnings && meta.warnings.length > 0 && (
          <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-200 animate-fade-in">
            {meta.warnings[0]}
          </div>
        )}
      </main>
      <Tooltip />
      <ShortcutsOverlay />
    </div>
  )
}

function ViewToolbar() {
  const resetView = useCity((s) => s.resetView)
  const autoOrbit = useSettings((s) => s.autoOrbit)
  const set = useSettings((s) => s.set)
  const btn = 'flex items-center gap-1.5 rounded-lg border border-slate-700/70 bg-slate-900/80 px-2.5 py-1.5 text-[12px] text-slate-300 backdrop-blur hover:border-sky-400/50 hover:text-white'
  return (
    <div className="pointer-events-auto flex gap-1.5 self-start animate-fade-in" data-testid="view-toolbar">
      <button onClick={resetView} className={btn} title="Reset camera (R)" data-testid="reset-view">
        <Icon.Recenter size={14} /> Reset view
      </button>
      <button onClick={() => set({ autoOrbit: !autoOrbit })} className={`${btn} ${autoOrbit ? '!border-sky-400/60 !bg-sky-400/15 !text-sky-100' : ''}`} title="Slowly orbit the city (O)" aria-pressed={autoOrbit} data-testid="orbit-button">
        <Icon.Orbit size={14} /> Orbit
      </button>
      <button onClick={() => downloadScreenshot(screenshotName())} className={btn} title="Save a screenshot (S)" data-testid="screenshot-button">
        <Icon.Camera size={14} /> Screenshot
      </button>
    </div>
  )
}

function CityLoading() {
  return (
    <div className="absolute inset-0 flex gap-3 p-3" data-testid="city-loading">
      <div className="flex w-[272px] flex-col gap-3">
        <div className="panel space-y-3 p-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-16 w-full" />
        </div>
        <div className="panel p-4">
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center text-slate-400">
        <div className="relative h-24 w-24">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="absolute bottom-0 w-4 animate-pulse rounded-t bg-gradient-to-t from-sky-500/30 to-sky-300/70"
              style={{ left: i * 22 + 4, height: 30 + ((i * 37) % 60), animationDelay: `${i * 0.2}s`, animationDuration: '1.8s' }}
            />
          ))}
        </div>
        <div className="mt-4 text-[14px]">Building the city…</div>
      </div>
    </div>
  )
}

function CityError({ message }: { message: string }) {
  return (
    <div className="page flex h-full flex-col items-center justify-center gap-4 px-8 text-center" data-testid="city-error">
      <Logo size={40} />
      <div className="flex items-center gap-2 text-[18px] font-semibold text-rose-200">
        <Icon.Alert /> This city could not be loaded
      </div>
      <p className="max-w-md text-[14px] text-slate-400">{message}</p>
      <button onClick={() => navigate({ page: 'home' })} className="rounded-lg bg-sky-500 px-4 py-2 text-[14px] font-semibold text-slate-950 hover:bg-sky-400">
        Back to start
      </button>
    </div>
  )
}
