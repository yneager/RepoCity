import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { District, Layout } from '../api'
import { useSettings } from '../motion'
import { useCity } from '../store'
import { districtColor, plateHeight } from './geometry'

const HOVER = new THREE.Color('#3b4a66')
const SELECTED = new THREE.Color('#1e4f7a')

/** One instanced slab per directory district, stacked by nesting depth. Hover / click selects a district. */
export function DistrictPlates({ layout }: { layout: Layout }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const invalidate = useThree((s) => s.invalidate)
  const ds = layout.districts
  const ph = plateHeight(layout.size)
  const hovered = useCity((s) => s.hoveredDistrict)
  const selected = useCity((s) => s.selectedDistrict)
  const setHovered = useCity((s) => s.setHoveredDistrict)
  const selectDistrict = useCity((s) => s.selectDistrict)
  const geometry = useMemo(() => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    g.translate(0.5, 0.5, 0.5) // origin at the min corner
    return g
  }, [])
  const base = useMemo(() => ds.map((d) => new THREE.Color(...districtColor(d.depth))), [ds])
  const colors = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, ds.length) * 3), 3)
    base.forEach((c, i) => a.setXYZ(i, c.r, c.g, c.b))
    return a
  }, [ds, base])
  // animated highlight amount per plate
  const glow = useRef({ cur: new Float32Array(ds.length), active: new Set<number>() })

  useEffect(() => {
    const m = mesh.current
    if (!m) return
    const mat = new THREE.Matrix4()
    ds.forEach((d, i) => {
      // plate of depth k spans from (k-1)*ph to k*ph
      mat.makeScale(Math.max(d.w, 0.001), ph, Math.max(d.h, 0.001))
      mat.setPosition(d.x, (d.depth - 1) * ph, d.y)
      m.setMatrixAt(i, mat)
    })
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
    glow.current = { cur: new Float32Array(ds.length), active: new Set<number>() }
    invalidate()
  }, [ds, ph, invalidate])

  useEffect(() => {
    if (hovered != null) glow.current.active.add(hovered)
    if (selected != null) glow.current.active.add(selected)
    invalidate()
  }, [hovered, selected, invalidate])

  useFrame((_, dt) => {
    const g = glow.current
    if (!g.active.size) return
    const tmp = new THREE.Color()
    let moving = false
    for (const i of g.active) {
      const target = i === selected ? 1 : i === hovered ? 0.6 : 0
      g.cur[i] += (target - g.cur[i]) * (1 - Math.exp(-6 * Math.min(dt, 0.1)))
      if (Math.abs(g.cur[i] - target) < 0.01) {
        g.cur[i] = target
        if (target === 0) g.active.delete(i)
      } else moving = true
      tmp.copy(base[i]).lerp(i === selected ? SELECTED : HOVER, Math.min(1, g.cur[i]))
      colors.setXYZ(i, tmp.r, tmp.g, tmp.b)
    }
    colors.needsUpdate = true
    if (moving) invalidate()
  })

  if (!ds.length) return null
  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, undefined, ds.length]}
      receiveShadow
      onPointerMove={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation()
        if (e.instanceId !== undefined) setHovered(e.instanceId)
      }}
      onPointerOut={() => setHovered(null)}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation()
        if (e.delta > 4 || e.instanceId === undefined) return
        selectDistrict(e.instanceId === selected ? null : e.instanceId)
      }}
      name="districts"
    >
      <primitive object={colors} attach="instanceColor" />
      <meshStandardMaterial roughness={0.95} metalness={0} />
    </instancedMesh>
  )
}

// ---- labels: DOM nodes positioned by projecting district anchors every frame -------------------

export const labelNodes: (HTMLDivElement | null)[] = []

export function pickLabelDistricts(ds: District[], max = 90): number[] {
  return ds
    .map((d, i) => [d, i] as const)
    .filter(([d]) => d.depth <= 5)
    .sort((a, b) => b[0].w * b[0].h - a[0].w * a[0].h)
    .slice(0, max)
    .map(([, i]) => i)
}

export function LabelLayer({ layout, picks }: { layout: Layout; picks: number[] }) {
  labelNodes.length = picks.length
  const show = useSettings((s) => s.showLabels)
  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-700 ${show ? 'opacity-100' : 'opacity-0'}`} aria-hidden>
      {picks.map((di, k) => {
        const d = layout.districts[di]
        return (
          <div
            key={d.path}
            ref={(el) => {
              labelNodes[k] = el
            }}
            className={`district-label ${d.depth <= 1 ? 'district-label--top' : ''}`}
            style={{ opacity: 0 }}
          >
            {d.label}
          </div>
        )
      })}
    </div>
  )
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Inside the Canvas: fades labels in when their district is big enough on screen, out when huge.
 *  Opacity eases towards its target so labels never pop. The hovered/selected district is emphasised. */
export function LabelProjector({ layout, picks }: { layout: Layout; picks: number[] }) {
  const { camera, size: viewport, invalidate } = useThree()
  const v = useMemo(() => new THREE.Vector3(), [])
  const ph = plateHeight(layout.size)
  const opacity = useRef(new Float32Array(picks.length))
  const hovered = useCity((s) => s.hoveredDistrict)
  const selected = useCity((s) => s.selectedDistrict)
  useEffect(() => {
    opacity.current = new Float32Array(picks.length)
  }, [picks])
  useEffect(() => {
    invalidate()
  }, [hovered, selected, invalidate])
  useFrame((_, dt) => {
    const cam = camera as THREE.PerspectiveCamera
    const focal = viewport.height / 2 / Math.tan((cam.fov * Math.PI) / 360)
    const k = 1 - Math.exp(-7 * Math.min(dt, 0.1))
    let moving = false
    for (let i = 0; i < picks.length; i++) {
      const el = labelNodes[i]
      if (!el) continue
      const di = picks[i]
      const d = layout.districts[di]
      v.set(d.x + d.w / 2, d.depth * ph, d.y + Math.min(d.h * 0.08, layout.size * 0.012))
      const dist = v.distanceTo(cam.position)
      const px = (d.w / Math.max(dist, 1)) * focal
      v.project(cam)
      const onScreen = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1
      const emphasised = di === hovered || di === selected
      const target = onScreen ? Math.max(emphasised ? 1 : 0, smooth(70, 150, px) * (1 - smooth(1600, 2600, px))) : 0
      const o = opacity.current[i] + (target - opacity.current[i]) * k
      opacity.current[i] = Math.abs(o - target) < 0.01 ? target : o
      if (opacity.current[i] !== target) moving = true
      el.style.opacity = opacity.current[i].toFixed(3)
      el.classList.toggle('district-label--active', emphasised)
      if (opacity.current[i] > 0) {
        const sx = (v.x * 0.5 + 0.5) * viewport.width
        const sy = (-v.y * 0.5 + 0.5) * viewport.height
        el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%)`
        el.style.maxWidth = `${Math.max(emphasised ? 160 : 60, px * 0.95).toFixed(0)}px`
      }
    }
    if (moving) invalidate()
  })
  return null
}
