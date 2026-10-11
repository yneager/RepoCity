import { useEffect, useMemo, useRef } from 'react'
import { formatMonth } from '../data/transforms'
import { cachedSnapshot, useCity } from '../store'
import { Icon } from '../ui'

const SPEEDS = [1, 2, 4, 8, 16]

/** Advances the month while playing; waits (instead of skipping) if a snapshot is still loading. */
function usePlayback() {
  const playing = useCity((s) => s.playing)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    const tick = (now: number) => {
      const st = useCity.getState()
      const meta = st.meta
      if (!meta) return
      acc += ((now - last) / 1000) * st.speed
      last = now
      while (acc >= 1) {
        const next = st.monthIndex + 1
        if (next >= meta.months.length) {
          st.setPlaying(false)
          return
        }
        if (!cachedSnapshot(meta.months[next])) {
          acc = Math.min(acc, 1)
          break
        }
        st.setMonthIndex(next)
        acc -= 1
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])
}

export function Timeline() {
  usePlayback()
  const meta = useCity((s) => s.meta)
  const stats = useCity((s) => s.monthStats)
  const idx = useCity((s) => s.monthIndex)
  const playing = useCity((s) => s.playing)
  const speed = useCity((s) => s.speed)
  const loaded = useCity((s) => s.snapshotsLoaded)
  const setMonthIndex = useCity((s) => s.setMonthIndex)
  const setSpeed = useCity((s) => s.setSpeed)
  const rangeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return
      const st = useCity.getState()
      if (st.mode !== 'explore') return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowRight' && tag !== 'INPUT') st.setMonthIndex(st.monthIndex + 1)
      else if (e.key === 'ArrowLeft' && tag !== 'INPUT') st.setMonthIndex(st.monthIndex - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const chart = useMemo(() => {
    if (!stats.length) return ''
    const max = Math.max(1, ...stats.map((s) => s.loc))
    const w = 1000
    const step = stats.length > 1 ? w / (stats.length - 1) : w
    const pts = stats.map((s, i) => `${(i * step).toFixed(1)},${(40 - (s.loc / max) * 36).toFixed(1)}`)
    return `M0,40 L${pts.join(' L')} L${w},40 Z`
  }, [stats])

  const years = useMemo(() => {
    if (!meta) return []
    const n = meta.months.length
    const ys = meta.months.map((m, i) => ({ m, i })).filter(({ m }) => m.endsWith('-01'))
    const every = Math.ceil(ys.length / 14)
    return ys.filter((_, k) => k % every === 0).map(({ m, i }) => ({ label: m.slice(0, 4), pct: (i / Math.max(1, n - 1)) * 100 }))
  }, [meta])

  if (!meta) return null
  const month = meta.months[idx]
  const st = stats[idx]

  function togglePlay() {
    const s = useCity.getState()
    if (!s.meta) return
    if (!s.playing && s.monthIndex >= s.meta.months.length - 1) s.setMonthIndex(0)
    s.setPlaying(!s.playing)
  }

  return (
    <div className="panel pointer-events-auto flex items-center gap-4 px-4 py-3" data-testid="timeline">
      <button
        onClick={togglePlay}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-500 text-slate-950 shadow-lg shadow-sky-500/20 transition hover:bg-sky-400"
        aria-label={playing ? 'Pause' : 'Play history'}
        data-testid="play-button"
      >
        {playing ? <Icon.Pause size={18} /> : <Icon.Play size={18} />}
      </button>
      <div className="w-[118px] shrink-0">
        <div className="text-[19px] font-semibold tabular-nums text-white" data-testid="timeline-date">{formatMonth(month)}</div>
        <div className="text-[11px] text-slate-400">
          {st ? `${st.files} files · ${st.commits} commits` : ''}
        </div>
      </div>
      <div className="relative min-w-0 flex-1">
        <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 top-[-8px] h-[30px] w-full opacity-70" aria-hidden>
          <path d={chart} fill="rgb(56 189 248 / 0.14)" stroke="rgb(56 189 248 / 0.35)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        <input
          ref={rangeRef}
          type="range"
          min={0}
          max={meta.months.length - 1}
          value={idx}
          onChange={(e) => setMonthIndex(Number(e.target.value))}
          className="timeline-range relative"
          aria-label="Month"
          aria-valuetext={formatMonth(month)}
          data-testid="timeline-slider"
        />
        <div className="relative h-3.5">
          {years.map((y) => (
            <span key={y.label} className="absolute -translate-x-1/2 text-[10px] tabular-nums text-slate-500" style={{ left: `${y.pct}%` }}>
              {y.label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="seg" role="group" aria-label="Playback speed (months per second)">
          {SPEEDS.map((s) => (
            <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)} className="!px-2 !py-1 !text-[11.5px]">
              {s}×
            </button>
          ))}
        </div>
        <div className="text-[10.5px] text-slate-500" data-testid="snapshots-loaded">
          {loaded < meta.months.length ? `loading history ${Math.round((100 * loaded) / meta.months.length)}%` : 'months per second'}
        </div>
      </div>
    </div>
  )
}
