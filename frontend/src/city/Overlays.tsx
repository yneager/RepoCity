import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { MOTION, easeOutCubic, useSettings } from '../motion'
import { cityAnim } from './anim'

const boxEdges = (() => {
  const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))
  g.translate(0, 0.5, 0)
  return g
})()

function placeOutline(obj: THREE.Object3D, i: number, grow: number, minSide: number) {
  const { x, z, base, h, sx, sz } = cityAnim
  if (i < 0 || i >= cityAnim.n || sx[i] <= 0.02) {
    obj.visible = false
    return
  }
  obj.visible = true
  obj.position.set(x[i], base[i], z[i])
  obj.scale.set(Math.max(sx[i] * grow, minSide), h[i] * 1.01 + minSide * 0.3, Math.max(sz[i] * grow, minSide))
}

/** Bright wireframe around the selected building: fades in, breathes for a few seconds, then rests. */
export function SelectionOutline({ index, size }: { index: number | null; size: number }) {
  const ref = useRef<THREE.LineSegments>(null)
  const invalidate = useThree((s) => s.invalidate)
  const since = useRef(0)
  const last = useRef<number | null>(null)
  useEffect(() => {
    since.current = performance.now() / 1000
    invalidate()
  }, [index, invalidate])
  useFrame(() => {
    const obj = ref.current
    if (!obj) return
    const shown = index ?? last.current ?? -1
    if (index != null) last.current = index
    placeOutline(obj, shown, 1.18, size * 0.003)
    const m = obj.material as THREE.LineBasicMaterial
    const t = performance.now() / 1000 - since.current
    const dur = Math.max(0.15, MOTION[useSettings.getState().motion].ui * 0.6)
    if (index == null) {
      m.opacity = Math.max(0, 1 - t / dur) * 0.9
      if (m.opacity > 0) invalidate()
      else last.current = null
      return
    }
    const fade = easeOutCubic(t / dur)
    const breathe = t < 4 ? 0.2 * Math.sin(t * 3.2) * (1 - t / 4) : 0
    m.opacity = Math.min(1, fade * (0.85 + breathe))
    if (t < 4) invalidate()
  })
  return (
    <lineSegments ref={ref} geometry={boxEdges} raycast={() => null} renderOrder={10}>
      <lineBasicMaterial color="#e0f2fe" transparent opacity={0} depthTest={false} />
    </lineSegments>
  )
}

/** Outlines around a set of buildings (the model's top-k in amber, the hotspot baseline's in cyan). */
export function TopKOutlines({ indices, size, color = '#fbbf24', grow = 1.22 }: { indices: number[]; size: number; color?: string; grow?: number }) {
  const group = useRef<THREE.Group>(null)
  const invalidate = useThree((s) => s.invalidate)
  const material = useMemo(() => new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false }), [color])
  const since = useRef(0)
  useEffect(() => {
    since.current = performance.now() / 1000
    invalidate()
  }, [indices, invalidate])
  useFrame(() => {
    const g = group.current
    if (!g) return
    g.children.forEach((c, k) => placeOutline(c, indices[k], grow, size * 0.004))
    const dur = Math.max(0.2, MOTION[useSettings.getState().motion].ui * 1.2)
    const t = (performance.now() / 1000 - since.current) / dur
    material.opacity = 0.95 * easeOutCubic(t)
    if (t < 1) invalidate()
  })
  return (
    <group ref={group}>
      {indices.map((i) => (
        <lineSegments key={i} geometry={boxEdges} material={material} raycast={() => null} renderOrder={9} />
      ))}
    </group>
  )
}

const markerGeometry = new THREE.OctahedronGeometry(1, 0)
const ringGeometry = (() => {
  const g = new THREE.TorusGeometry(1, 0.12, 6, 32)
  g.rotateX(Math.PI / 2)
  return g
})()

/** Pulsing diamonds (+ a ring on the roof) above files that actually received bug fixes after the cutoff.
 *  Green = predicted (in top-k), magenta = missed by the model. They float down one after another. */
export function RevealMarkers({ indices, hits, size }: { indices: number[]; hits: Set<number>; size: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const rings = useRef<THREE.InstancedMesh>(null)
  const invalidate = useThree((s) => s.invalidate)
  const start = useRef(0)
  const colors = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, indices.length) * 3), 3)
    const hit = new THREE.Color('#4ade80')
    const miss = new THREE.Color('#f0abfc')
    indices.forEach((b, k) => {
      const c = hits.has(b) ? hit : miss
      a.setXYZ(k, c.r, c.g, c.b)
    })
    return a
  }, [indices, hits])
  const ringColors = useMemo(() => colors.clone(), [colors])
  useEffect(() => {
    start.current = performance.now() / 1000
    invalidate()
  }, [indices, invalidate])
  const tmp = useMemo(() => new THREE.Matrix4(), [])
  useFrame(() => {
    const m = mesh.current
    const rg = rings.current
    if (!m || !rg) return
    const ui = Math.max(0.15, MOTION[useSettings.getState().motion].ui)
    const t = performance.now() / 1000 - start.current
    const r = size * 0.015
    const stagger = Math.min(0.09 * ui, 2.5 / Math.max(1, indices.length))
    indices.forEach((b, k) => {
      // staggered float-down, then a gentle pulse and bob
      const appear = Math.min(1, Math.max(0, (t - k * stagger) / (1.1 * ui)))
      const ease = easeOutCubic(appear)
      const pulse = 1 + 0.16 * Math.sin(t * 3.2 + k)
      const roof = cityAnim.base[b] + cityAnim.h[b]
      const y = roof + r * 2.6 + Math.sin(t * 1.4 + k) * r * 0.35 + (1 - ease) * size * 0.12
      const s = r * pulse * ease
      tmp.makeScale(s, s * 1.5, s)
      tmp.setPosition(cityAnim.x[b], y, cityAnim.z[b])
      m.setMatrixAt(k, tmp)
      const phase = (t * 0.55 + k * 0.13) % 1
      const rr = (Math.max(cityAnim.sx[b], cityAnim.sz[b]) * (0.22 + phase * 0.28) + r * 0.6) * ease
      tmp.makeScale(rr, rr, rr)
      tmp.setPosition(cityAnim.x[b], roof + 0.3, cityAnim.z[b])
      rg.setMatrixAt(k, tmp)
    })
    m.instanceMatrix.needsUpdate = true
    rg.instanceMatrix.needsUpdate = true
    invalidate() // the markers keep breathing while shown
  })
  if (!indices.length) return null
  return (
    <group>
      <instancedMesh ref={mesh} args={[markerGeometry, undefined, indices.length]} frustumCulled={false} raycast={() => null} renderOrder={11}>
        <primitive object={colors} attach="instanceColor" />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={rings} args={[ringGeometry, undefined, indices.length]} frustumCulled={false} raycast={() => null}>
        <primitive object={ringColors} attach="instanceColor" />
        <meshBasicMaterial toneMapped={false} transparent opacity={0.85} />
      </instancedMesh>
    </group>
  )
}

const sparkGeometry = new THREE.IcosahedronGeometry(1, 1)
const MAX_SPARKS = 400

/** Brief red flashes where SZZ says a bug was born this month (timeline replay). */
export function BugSparks({ born, enabled, size }: { born: ArrayLike<number> | null; enabled: boolean; size: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const invalidate = useThree((s) => s.invalidate)
  const sparks = useRef<{ i: number; t0: number }[]>([])
  const tmp = useMemo(() => new THREE.Matrix4(), [])
  useEffect(() => {
    if (!enabled || !born) return
    const now = performance.now() / 1000
    for (let i = 0; i < born.length; i++) {
      if (born[i] > 0 && sparks.current.length < MAX_SPARKS) sparks.current.push({ i, t0: now + Math.random() * 0.25 })
    }
    invalidate()
  }, [born, enabled, invalidate])
  useFrame(() => {
    const m = mesh.current
    if (!m) return
    const now = performance.now() / 1000
    const life = 2.2
    sparks.current = sparks.current.filter((s) => now - s.t0 < life)
    const r = size * 0.006
    let k = 0
    for (const s of sparks.current) {
      const age = Math.max(0, (now - s.t0) / life)
      const sc = r * Math.sin(Math.PI * Math.min(1, age)) * 1.7
      tmp.makeScale(sc, sc, sc)
      tmp.setPosition(cityAnim.x[s.i], cityAnim.base[s.i] + cityAnim.h[s.i] + r * (1 + age * 5), cityAnim.z[s.i])
      m.setMatrixAt(k++, tmp)
    }
    m.count = k
    m.instanceMatrix.needsUpdate = true
    if (k > 0) invalidate()
  })
  return (
    <instancedMesh ref={mesh} args={[sparkGeometry, undefined, MAX_SPARKS]} frustumCulled={false} raycast={() => null}>
      <meshStandardMaterial color="#ff3b3b" emissive="#ff2020" emissiveIntensity={1.2} />
    </instancedMesh>
  )
}
