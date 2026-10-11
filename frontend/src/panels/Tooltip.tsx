import { useEffect, useLayoutEffect, useRef } from 'react'
import { formatNumber } from '../data/transforms'
import { useCity } from '../store'

/** Hover tooltip that follows the mouse (position updated without React re-renders). */
export function Tooltip() {
  const ref = useRef<HTMLDivElement>(null)
  const hovered = useCity((s) => s.hovered)
  const layout = useCity((s) => s.layout)
  const snapshot = useCity((s) => s.snapshot)
  const mode = useCity((s) => s.mode)
  const prediction = useCity((s) => s.prediction)

  const pos = useRef({ x: 0, y: 0 })
  const place = () => {
    const el = ref.current
    if (!el) return
    const { x, y } = pos.current
    const flip = x > window.innerWidth - 360
    el.style.transform = `translate(${x + (flip ? -16 : 16)}px, ${y + 16}px) translateX(${flip ? '-100%' : '0'})`
  }
  useEffect(() => {
    const move = (e: PointerEvent) => {
      pos.current = { x: e.clientX, y: e.clientY }
      place()
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [])
  useLayoutEffect(place)

  if (hovered == null || !layout || !snapshot || snapshot.loc[hovered] <= 0) return <div ref={ref} className="hidden" />
  const path = layout.files.path[hovered]
  const cut = path.lastIndexOf('/')
  let risk = snapshot.risk[hovered]
  if (mode === 'pvr' && prediction) {
    const j = prediction.files.indexOf(hovered)
    risk = j >= 0 ? (prediction.riskPct[j] ?? -1) : -1
  }
  return (
    <div ref={ref} className="pointer-events-none fixed left-0 top-0 z-50 max-w-[340px] rounded-xl border border-slate-600/50 bg-ink-850/95 px-3 py-2.5 shadow-2xl backdrop-blur" data-testid="tooltip">
      <div className="truncate text-[11.5px] text-slate-400">{path.slice(0, cut + 1)}</div>
      <div className="truncate text-[13.5px] font-semibold text-white">{path.slice(cut + 1)}</div>
      <div className="mt-2 grid grid-cols-3 gap-3 text-[12px]">
        <div>
          <div className="text-slate-500">LOC</div>
          <div className="font-semibold tabular-nums">{formatNumber(snapshot.loc[hovered])}</div>
        </div>
        <div>
          <div className="text-slate-500">Churn</div>
          <div className="font-semibold tabular-nums">{formatNumber(snapshot.churn[hovered])}</div>
        </div>
        <div>
          <div className="text-slate-500">Risk</div>
          <div className="font-semibold tabular-nums">{risk < 0 ? 'n/a' : `${Math.round(risk * 100)}th pct`}</div>
        </div>
      </div>
    </div>
  )
}
