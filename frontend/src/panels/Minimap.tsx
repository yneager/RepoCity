import { useEffect, useRef, useState } from 'react'
import type { Layout } from '../api'
import { cityAnim } from '../city/anim'
import { useCity } from '../store'

const SIZE = 172

/** A live top-down map of the city: building colours follow the 3D view, the wedge shows the camera.
 *  Click to fly there. Redraws only when the city or the camera changed. */
export function Minimap({ layout }: { layout: Layout }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const flyTo = useCity((s) => s.flyTo)
  const selected = useCity((s) => s.selected)
  const [hover, setHover] = useState<[number, number] | null>(null)

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = SIZE * dpr
    c.height = SIZE * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    let raf = 0
    let lastVersion = -1
    let lastCam = ''
    let lastDraw = 0
    const s = (SIZE * dpr) / layout.size
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const cam = cityAnim.camera
      const camKey = `${cam.x.toFixed(0)},${cam.z.toFixed(0)},${cam.tx.toFixed(0)},${cam.tz.toFixed(0)},${selected}`
      if (cityAnim.version === lastVersion && camKey === lastCam) return
      const now = performance.now()
      if (now - lastDraw < 120) return // at most ~8 redraws per second
      lastDraw = now
      lastVersion = cityAnim.version
      lastCam = camKey
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.fillStyle = '#0f172a'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.strokeStyle = 'rgba(148,163,184,0.18)'
      ctx.lineWidth = 1
      for (const d of layout.districts) {
        if (d.depth > 1) continue
        ctx.strokeRect(d.x * s + 0.5, d.y * s + 0.5, d.w * s - 1, d.h * s - 1)
      }
      const { n, x, z, sx, sz, color } = cityAnim
      for (let i = 0; i < n; i++) {
        if (sx[i] <= 0.02) continue
        const w = Math.max(1, sx[i] * s)
        const h = Math.max(1, sz[i] * s)
        ctx.fillStyle = `rgb(${(color[i * 3] * 255) | 0},${(color[i * 3 + 1] * 255) | 0},${(color[i * 3 + 2] * 255) | 0})`
        ctx.fillRect(x[i] * s - w / 2, z[i] * s - h / 2, w, h)
      }
      if (selected != null && selected < n) {
        ctx.strokeStyle = '#e0f2fe'
        ctx.lineWidth = 2 * dpr
        const w = Math.max(4, sx[selected] * s) + 4
        ctx.strokeRect(x[selected] * s - w / 2, z[selected] * s - w / 2, w, w)
      }
      // camera wedge: from the camera's ground position towards the look-at target
      const ax = cam.tx * s
      const az = cam.tz * s
      const dx = cam.x * s - ax
      const dz = cam.z * s - az
      const len = Math.hypot(dx, dz) || 1
      const ux = dx / len
      const uz = dz / len
      const reach = Math.min(len, SIZE * dpr * 0.32)
      ctx.fillStyle = 'rgba(56,189,248,0.18)'
      ctx.beginPath()
      ctx.moveTo(ax + ux * reach, az + uz * reach)
      ctx.lineTo(ax - uz * reach * 0.55, az + ux * reach * 0.55)
      ctx.lineTo(ax + uz * reach * 0.55, az - ux * reach * 0.55)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#38bdf8'
      ctx.beginPath()
      ctx.arc(ax, az, 3.2 * dpr, 0, Math.PI * 2)
      ctx.fill()
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [layout, selected])

  const toWorld = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * layout.size, ((e.clientY - r.top) / r.height) * layout.size] as [number, number]
  }

  return (
    <div className="panel pointer-events-auto p-2 animate-slide-in" data-testid="minimap">
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <canvas
          ref={canvas}
          style={{ width: SIZE, height: SIZE }}
          className="cursor-crosshair rounded-lg"
          onMouseMove={(e) => setHover(toWorld(e))}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const [wx, wz] = toWorld(e)
            flyTo({ x: wx, y: 0, z: wz, distance: layout.size * 0.32 })
          }}
          aria-label="Minimap: click to fly the camera there"
          role="img"
        />
        {hover && (
          <div
            className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-300/70"
            style={{ left: (hover[0] / layout.size) * SIZE, top: (hover[1] / layout.size) * SIZE }}
          />
        )}
      </div>
    </div>
  )
}
