import { useEffect, useMemo, useRef, useState } from 'react'
import { formatMonth } from '../data/transforms'
import { cachedSnapshot, useCity } from '../store'
import { AnimatedNumber, Icon } from '../ui'

const SPEEDS = [0.5, 1, 2, 4, 8, 16]

/** Advances the month while playing; waits (instead of skipping) if a snapshot is still loading.
 *  Reports a continuous playhead (month + fraction) so the thumb glides instead of ticking. */
function usePlayback(onPlayhead: (v: number) => void) {
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
          if (st.loop) {
            st.setMonthIndex(0)
            acc = 0
            break
          }
          st.setPlaying(false)
          onPlayhead(meta.months.length - 1)
          return
        }
        if (!cachedSnapshot(meta.months[next])) {
          acc = Math.min(acc, 0.999)
          break
        }
        st.setMonthIndex(next)
        acc -= 1
      }
      const s2 = useCity.getState()
      onPlayhead(Math.min(meta.months.length - 1, s2.monthIndex + acc))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, onPlayhead])
}

export function Timeline() {
  const meta = useCity((s) => s.meta)
  const stats = useCity((s) => s.monthStats)
  const idx = useCity((s) => s.monthIndex)
  const playing = useCity((s) => s.playing)
  const speed = useCity((s) => s.speed)
  const loop = useCity((s) => s.loop)
  const loaded = useCity((s) => s.snapshotsLoaded)
  const setMonthIndex = useCity((s) => s.setMonthIndex)
  const togglePlay = useCity((s) => s.togglePlay)
  const setSpeed = useCity((s) => s.setSpeed)
  const setLoop = useCity((s) => s.setLoop)
  const [playhead, setPlayhead] = useState(idx)
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null)
  const track = useRef<HTMLDivElement>(null)
  usePlayback(setPlayhead)

  useEffect(() => {
    if (!playing) setPlayhead(idx)
  }, [idx, playing])

  const n = meta?.months.length ?? 1
  const pct = (v: number) => (v / Math.max(1, n - 1)) * 100

  const chart = useMemo(() => {
    if (!stats.length) return { area: '', fixes: [] as [number, number][], born: [] as [number, number][] }
    const maxLoc = Math.max(1, ...stats.map((s) => s.loc))
    const w = 1000
    const step = stats.length > 1 ? w / (stats.length - 1) : w
    const pts = stats.map((s, i) => `${(i * step).toFixed(1)},${(40 - (s.loc / maxLoc) * 36).toFixed(1)}`)
    const fx = stats.map((s, i) => s.fixesMonth ?? Math.max(0, s.fixes - (stats[i - 1]?.fixes ?? 0)))
    const maxFix = Math.max(1, ...fx)
    const maxBorn = Math.max(1, ...stats.map((s) => s.born ?? 0))
    return {
      area: `M0,40 L${pts.join(' L')} L${w},40 Z`,
      fixes: fx.map((v, i) => [i, v / maxFix] as [number, number]).filter(([, v]) => v > 0),
      born: stats.map((s, i) => [i, (s.born ?? 0) / maxBorn] as [number, number]).filter(([, v]) => v > 0),
    }
  }, [stats])

  const years = useMemo(() => {
    if (!meta) return []
    const ys = meta.months.map((m, i) => ({ m, i })).filter(({ m }) => m.endsWith('-01'))
    const every = Math.ceil(ys.length / 14)
    return ys.filter((_, k) => k % every === 0).map(({ m, i }) => ({ label: m.slice(0, 4), pct: pct(i) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta])

  if (!meta) return null
  const month = meta.months[idx]
  const st = stats[idx]

  const monthAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return { i: Math.round(f * (n - 1)), x: f * r.width }
  }

  return (
    <div className="panel pointer-events-auto flex items-center gap-4 px-4 py-3 animate-rise" data-testid="timeline">
      <button
        onClick={togglePlay}
        className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-950 shadow-lg ${playing ? 'bg-amber-300 shadow-amber-400/25' : 'bg-sky-500 shadow-sky-500/25 hover:bg-sky-400'}`}
        aria-label={playing ? 'Pause' : 'Play history'}
        data-testid="play-button"
      >
        <span className={`absolute transition-all duration-500 ${playing ? 'scale-50 opacity-0' : 'scale-100 opacity-100'}`}>
          <Icon.Play size={18} />
        </span>
        <span className={`absolute transition-all duration-500 ${playing ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}>
          <Icon.Pause size={18} />
        </span>
        {playing && <span className="absolute inset-0 animate-ping rounded-full bg-amber-300/30 [animation-duration:2.4s]" />}
      </button>
      <div className="w-[124px] shrink-0">
        <div key={month} className="text-[19px] font-semibold tabular-nums text-white animate-[fade-in_var(--dur-fast)_var(--ease-out)_both]" data-testid="timeline-date">
          {formatMonth(month)}
        </div>
        <div className="text-[11px] text-slate-400">
          {st ? (
            <>
              <AnimatedNumber value={st.files} duration={0.6} /> files · <AnimatedNumber value={st.commits} duration={0.6} /> commits
            </>
          ) : null}
        </div>
      </div>
      <div className="relative min-w-0 flex-1 select-none">
        <div
          ref={track}
          className="relative h-[42px] cursor-pointer"
          onPointerDown={(e) => {
            ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
            setDragging(true)
            if (playing) useCity.getState().setPlaying(false)
            const { i } = monthAt(e.clientX)
            setMonthIndex(i)
          }}
          onPointerMove={(e) => {
            const h = monthAt(e.clientX)
            setHover(h)
            if (dragging && h.i !== useCity.getState().monthIndex) setMonthIndex(h.i)
          }}
          onPointerUp={() => setDragging(false)}
          onPointerLeave={() => setHover(null)}
          data-testid="timeline-track"
        >
          <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 top-0 h-[28px] w-full" aria-hidden>
            <path d={chart.area} fill="rgb(56 189 248 / 0.13)" stroke="rgb(56 189 248 / 0.38)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          </svg>
          {/* bug-fix activity (red) and bug births per SZZ (amber), one tick per month */}
          <svg viewBox={`0 0 ${Math.max(1, n - 1)} 10`} preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 top-[29px] h-[7px] w-full" aria-hidden>
            {chart.fixes.map(([i, v]) => (
              <rect key={`f${i}`} x={i - 0.35} y={10 - v * 10} width={0.7} height={v * 10} fill="rgb(251 113 133 / 0.75)" />
            ))}
          </svg>
          <svg viewBox={`0 0 ${Math.max(1, n - 1)} 10`} preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 top-[37px] h-[4px] w-full" aria-hidden>
            {chart.born.map(([i, v]) => (
              <rect key={`b${i}`} x={i - 0.35} y={0} width={0.7} height={10} fill={`rgb(251 191 36 / ${0.25 + v * 0.7})`} />
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-x-0 top-[28px] h-px bg-slate-600/60" />
          {/* progress fill + thumb */}
          <div
            className="pointer-events-none absolute left-0 top-[27px] h-[3px] rounded-full bg-sky-400/80"
            style={{ width: `${pct(playhead)}%`, transition: playing || dragging ? 'none' : 'width var(--dur) var(--ease-out)' }}
          />
          <div
            className="pointer-events-none absolute top-[28px] h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-400 shadow-[0_0_0_5px_rgb(56_189_248/0.22),0_2px_8px_rgb(0_0_0/0.5)]"
            style={{ left: `${pct(playhead)}%`, transition: playing || dragging ? 'none' : 'left var(--dur) var(--ease-out)' }}
            data-testid="timeline-thumb"
          />
          {hover && !dragging && (
            <div
              className="pointer-events-none absolute bottom-[46px] z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-slate-600/50 bg-ink-850/95 px-2.5 py-1.5 text-[11.5px] shadow-xl tooltip-enter"
              style={{ left: hover.x }}
            >
              <div className="font-semibold text-white">{formatMonth(meta.months[hover.i])}</div>
              <div className="text-slate-400">
                {stats[hover.i]?.files ?? 0} files · {stats[hover.i]?.commitsMonth ?? '–'} commits · <span className="text-rose-300">{stats[hover.i]?.fixesMonth ?? '–'} fixes</span>
                {(stats[hover.i]?.born ?? 0) > 0 && <span className="text-amber-300"> · {stats[hover.i]?.born} bugs born</span>}
              </div>
            </div>
          )}
        </div>
        <input
          type="range"
          min={0}
          max={n - 1}
          value={idx}
          onChange={(e) => setMonthIndex(Number(e.target.value))}
          className="sr-only"
          aria-label="Month"
          aria-valuetext={formatMonth(month)}
          data-testid="timeline-slider"
        />
        <div className="relative mt-0.5 h-3.5">
          {years.map((y) => (
            <span key={y.label} className="absolute -translate-x-1/2 text-[10px] tabular-nums text-slate-500" style={{ left: `${y.pct}%` }}>
              {y.label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setLoop(!loop)}
            aria-pressed={loop}
            title="Loop playback"
            className={`rounded-md p-1.5 ${loop ? 'bg-sky-400/15 text-sky-200' : 'text-slate-500 hover:text-slate-200'}`}
            data-testid="loop-button"
          >
            <Icon.Loop size={14} />
          </button>
          <div className="seg" role="group" aria-label="Playback speed (months per second)">
            {SPEEDS.map((s) => (
              <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)} className="!px-2 !py-1 !text-[11.5px]">
                {s}×
              </button>
            ))}
          </div>
        </div>
        <div className="text-[10.5px] text-slate-500" data-testid="snapshots-loaded">
          {loaded < meta.months.length ? `loading history ${Math.round((100 * loaded) / meta.months.length)}%` : 'months per second · red = bug fixes · amber = bugs born'}
        </div>
      </div>
    </div>
  )
}
