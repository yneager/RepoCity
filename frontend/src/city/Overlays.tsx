import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
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

/** Bright wireframe around the selected building. */
export function SelectionOutline({ index, size }: { index: number | null; size: number }) {
  const ref = useRef<THREE.LineSegments>(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    placeOutline(ref.current, index ?? -1, 1.18, size * 0.003)
    const m = ref.current.material as THREE.LineBasicMaterial
    m.opacity = 0.75 + 0.25 * Math.sin(clock.elapsedTime * 4)
  })
  return (
    <lineSegments ref={ref} geometry={boxEdges} raycast={() => null} renderOrder={10}>
      <lineBasicMaterial color="#e0f2fe" transparent depthTest={false} />
    </lineSegments>
  )
}

/** Amber outlines around the model's top-k riskiest files (Prediction vs Reality). */
export function TopKOutlines({ indices, size }: { indices: number[]; size: number }) {
  const group = useRef<THREE.Group>(null)
  const material = useMemo(() => new THREE.LineBasicMaterial({ color: '#fbbf24', transparent: true, depthTest: false }), [])
  useFrame(() => {
    const g = group.current
    if (!g) return
    g.children.forEach((c, k) => placeOutline(c, indices[k], 1.22, size * 0.004))
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

/** Pulsing diamonds above files that actually received bug fixes after the cutoff.
 *  Green = predicted (in top-k), magenta = missed by the model. */
export function RevealMarkers({ indices, hits, size }: { indices: number[]; hits: Set<number>; size: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const start = useRef(0)
  const colors = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, indices.length) * 3), 3)
    const hit = new THREE.Color('#4ade80')
    const miss = new THREE.Color('#e879f9')
    indices.forEach((b, k) => {
      const c = hits.has(b) ? hit : miss
      a.setXYZ(k, c.r, c.g, c.b)
    })
    return a
  }, [indices, hits])
  useEffect(() => {
    start.current = performance.now() / 1000
  }, [indices])
  const tmp = useMemo(() => new THREE.Matrix4(), [])
  useFrame(() => {
    const m = mesh.current
    if (!m) return
    const t = performance.now() / 1000 - start.current
    const r = size * 0.0075
    indices.forEach((b, k) => {
      // staggered drop-in, then a gentle pulse and bob
      const appear = Math.min(1, Math.max(0, (t - k * 0.04) / 0.5))
      const ease = 1 - Math.pow(1 - appear, 3)
      const pulse = 1 + 0.18 * Math.sin(t * 5 + k)
      const y = cityAnim.base[b] + cityAnim.h[b] + r * 2.2 + Math.sin(t * 2 + k) * r * 0.35 + (1 - ease) * size * 0.08
      const s = r * pulse * ease
      tmp.makeScale(s, s * 1.4, s)
      tmp.setPosition(cityAnim.x[b], y, cityAnim.z[b])
      m.setMatrixAt(k, tmp)
    })
    m.instanceMatrix.needsUpdate = true
  })
  if (!indices.length) return null
  return (
    <instancedMesh ref={mesh} args={[markerGeometry, undefined, indices.length]} frustumCulled={false} raycast={() => null}>
      <primitive object={colors} attach="instanceColor" />
      <meshStandardMaterial emissive="#ffffff" emissiveIntensity={0.35} roughness={0.3} />
    </instancedMesh>
  )
}

const sparkGeometry = new THREE.IcosahedronGeometry(1, 1)
const MAX_SPARKS = 400

/** Brief red flashes where SZZ says a bug was born this month (timeline replay). */
export function BugSparks({ born, enabled, size }: { born: number[] | null; enabled: boolean; size: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const sparks = useRef<{ i: number; t0: number }[]>([])
  const tmp = useMemo(() => new THREE.Matrix4(), [])
  useEffect(() => {
    if (!enabled || !born) return
    const now = performance.now() / 1000
    born.forEach((v, i) => {
      if (v > 0 && sparks.current.length < MAX_SPARKS) sparks.current.push({ i, t0: now })
    })
  }, [born, enabled])
  useFrame(() => {
    const m = mesh.current
    if (!m) return
    const now = performance.now() / 1000
    sparks.current = sparks.current.filter((s) => now - s.t0 < 1.6)
    const r = size * 0.006
    let k = 0
    for (const s of sparks.current) {
      const age = (now - s.t0) / 1.6
      const sc = r * Math.sin(Math.PI * Math.min(1, age)) * 1.6
      tmp.makeScale(sc, sc, sc)
      tmp.setPosition(cityAnim.x[s.i], cityAnim.base[s.i] + cityAnim.h[s.i] + r * (1 + age * 4), cityAnim.z[s.i])
      m.setMatrixAt(k++, tmp)
    }
    m.count = k
    m.instanceMatrix.needsUpdate = true
  })
  return (
    <instancedMesh ref={mesh} args={[sparkGeometry, undefined, MAX_SPARKS]} frustumCulled={false} raycast={() => null}>
      <meshStandardMaterial color="#ff3b3b" emissive="#ff2020" emissiveIntensity={1.2} />
    </instancedMesh>
  )
}
