import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Layout, Meta, Snapshot } from '../api'
import { encodeSnapshot, heatNormalised, heatValues, riskFromPrediction, type Encoded, type Masks } from '../data/transforms'
import { MOTION, smoothDamp, useSettings } from '../motion'
import { useCity } from '../store'
import { cityAnim, pickBuilding, resetAnim } from './anim'
import { buildingBases } from './geometry'

const HOVER_MIX = 0.38
const EPS = 0.01

interface Props {
  layout: Layout
  meta: Meta
  snapshot: Snapshot
  masks: Masks | null
}

/**
 * All buildings in a single InstancedMesh (one draw call).
 *
 * Animation: heights and footprints follow a critically damped spring (SmoothDamp) towards their
 * targets, colours ease exponentially. When the *encoding* changes (height/colour mode, heatmap,
 * prediction mode, filters) each building waits a delay proportional to its distance from the
 * city centre, so the change sweeps across the city as a wave; month-to-month replay changes
 * apply immediately. The first wave doubles as the "city rises" intro. Instance matrices are
 * written straight into the Float32Array (no Object3D per building), and frames are only
 * requested while something is still moving (the canvas renders on demand).
 */
export function Buildings({ layout, meta, snapshot, masks }: Props) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const invalidate = useThree((s) => s.invalidate)
  const n = layout.files.id.length
  const heightMode = useCity((s) => s.heightMode)
  const colorMode = useCity((s) => s.colorMode)
  const mode = useCity((s) => s.mode)
  const prediction = useCity((s) => s.prediction)
  const hovered = useCity((s) => s.hovered)
  const waveNonce = useCity((s) => s.waveNonce)
  const lagSnapshot = useCity((s) => s.lagSnapshot)
  const heatMetric = useCity((s) => s.heatMetric)
  const setHovered = useCity((s) => s.setHovered)
  const select = useCity((s) => s.select)
  const motion = useSettings((s) => s.motion)

  const state = useMemo(() => {
    const x = Float32Array.from(layout.files.x)
    const z = Float32Array.from(layout.files.z)
    resetAnim(x, z, buildingBases(layout), layout.size)
    const mid = layout.size / 2
    const dist = new Float32Array(n)
    for (let i = 0; i < n; i++) dist[i] = Math.min(1, Math.hypot(x[i] - mid, z[i] - mid) / (mid * Math.SQRT2))
    return {
      target: null as Encoded | null,
      active: true,
      vh: new Float32Array(n),
      vsx: new Float32Array(n),
      vsz: new Float32Array(n),
      delay: new Float32Array(n),
      hover: new Float32Array(n),
      hoverSet: new Set<number>(),
      hovered: -1,
      dist,
      lastWave: -1,
    }
  }, [layout, n])

  const geometry = useMemo(() => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    g.translate(0, 0.5, 0) // base at y = 0 so scaling grows upwards
    return g
  }, [])

  // instance colours must exist before the material's shader is compiled
  const colorAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [n])

  const heat = useMemo(
    () => (mode === 'heatmap' ? heatNormalised(heatValues(snapshot, lagSnapshot, heatMetric), snapshot.loc) : null),
    [mode, snapshot, lagSnapshot, heatMetric],
  )
  const riskOverride = useMemo(() => (mode === 'pvr' && prediction ? riskFromPrediction(prediction, n) : null), [mode, prediction, n])

  useEffect(() => {
    mesh.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  }, [n])

  useEffect(() => {
    state.target = encodeSnapshot(layout, meta, snapshot, { heightMode, colorMode, riskOverride, heat, masks })
    if (waveNonce !== state.lastWave) {
      // encoding change (or first appearance): sweep the change across the city from its centre
      const intro = state.lastWave < 0
      state.lastWave = waveNonce
      const spread = MOTION[useSettings.getState().motion].wave * (intro ? 1.7 : 1)
      const t0 = performance.now() / 1000 + (intro ? 0.35 : 0)
      for (let i = 0; i < n; i++) state.delay[i] = spread > 0 ? t0 + state.dist[i] * spread : 0
    }
    state.active = true
    invalidate()
  }, [layout, meta, snapshot, heightMode, colorMode, riskOverride, heat, masks, waveNonce, n, state, invalidate])

  useEffect(() => {
    state.hovered = hovered ?? -1
    if (hovered != null) state.hoverSet.add(hovered)
    state.active = true
    invalidate()
  }, [hovered, state, invalidate])

  useEffect(() => {
    state.active = true
    invalidate()
  }, [motion, state, invalidate])

  useFrame((_, delta) => {
    const m = mesh.current
    const t = state.target
    if (!m || !t || !state.active) return
    const t0 = performance.now()
    const now = t0 / 1000
    const dt = Math.min(delta, 0.1)
    const params = MOTION[useSettings.getState().motion]
    const { x, z, base, h, sx, sz } = cityAnim
    const mat = m.instanceMatrix.array as Float32Array
    const col = colorAttr.array as Float32Array
    const cur = cityAnim.color
    const colorK = 1 - Math.exp(-params.color * dt)
    let moving = false
    // hover glow fades in and out instead of switching
    for (const i of state.hoverSet) {
      const target = i === state.hovered ? 1 : 0
      state.hover[i] += (target - state.hover[i]) * (1 - Math.exp(-9 * dt))
      if (Math.abs(state.hover[i] - target) < 0.01) {
        state.hover[i] = target
        if (target === 0) state.hoverSet.delete(i)
      } else moving = true
    }
    for (let i = 0; i < n; i++) {
      if (state.delay[i] > now) {
        moving = true
      } else {
        const th = t.height[i]
        const tx = t.sx[i]
        const tz = t.sz[i]
        if (h[i] !== th || state.vh[i] !== 0) {
          h[i] = smoothDamp(h[i], th, state.vh, i, params.building, dt)
          if (Math.abs(h[i] - th) < EPS && Math.abs(state.vh[i]) < EPS) {
            h[i] = th
            state.vh[i] = 0
          } else moving = true
        }
        if (sx[i] !== tx || state.vsx[i] !== 0) {
          sx[i] = smoothDamp(sx[i], tx, state.vsx, i, params.building * 0.9, dt)
          if (Math.abs(sx[i] - tx) < EPS && Math.abs(state.vsx[i]) < EPS) {
            sx[i] = tx
            state.vsx[i] = 0
          } else moving = true
        }
        if (sz[i] !== tz || state.vsz[i] !== 0) {
          sz[i] = smoothDamp(sz[i], tz, state.vsz, i, params.building * 0.9, dt)
          if (Math.abs(sz[i] - tz) < EPS && Math.abs(state.vsz[i]) < EPS) {
            sz[i] = tz
            state.vsz[i] = 0
          } else moving = true
        }
        const c = i * 3
        for (let k = 0; k < 3; k++) {
          const d = t.color[c + k] - cur[c + k]
          if (d !== 0) {
            if (Math.abs(d) < 0.003) cur[c + k] = t.color[c + k]
            else {
              cur[c + k] += d * colorK
              moving = true
            }
          }
        }
      }
      const visible = sx[i] > 0.02 && h[i] > 0.02
      const o = i * 16
      mat[o] = visible ? sx[i] : 0
      mat[o + 1] = 0
      mat[o + 2] = 0
      mat[o + 3] = 0
      mat[o + 4] = 0
      mat[o + 5] = visible ? h[i] : 0
      mat[o + 6] = 0
      mat[o + 7] = 0
      mat[o + 8] = 0
      mat[o + 9] = 0
      mat[o + 10] = visible ? sz[i] : 0
      mat[o + 11] = 0
      mat[o + 12] = x[i]
      mat[o + 13] = base[i]
      mat[o + 14] = z[i]
      mat[o + 15] = 1
      const c = i * 3
      const hv = state.hover[i] * HOVER_MIX
      col[c] = cur[c] + (1 - cur[c]) * hv
      col[c + 1] = cur[c + 1] + (1 - cur[c + 1]) * hv
      col[c + 2] = cur[c + 2] + (1 - cur[c + 2]) * hv
    }
    m.instanceMatrix.needsUpdate = true
    colorAttr.needsUpdate = true
    cityAnim.version++
    const perf = window.__repocity
    if (perf) {
      perf.updateMs.push(performance.now() - t0)
      if (perf.updateMs.length > 2000) perf.updateMs.shift()
    }
    if (moving) invalidate()
    else {
      state.active = false
      m.computeBoundingSphere()
    }
  })

  // Analytic ray/box picking on the animation arrays (see anim.ts) instead of per-instance matrices.
  const raycast = useCallback(function (this: THREE.Object3D, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
    const r = raycaster.ray
    const hit = pickBuilding(r.origin.x, r.origin.y, r.origin.z, r.direction.x, r.direction.y, r.direction.z)
    if (hit && hit.distance >= raycaster.near && hit.distance <= raycaster.far) {
      intersects.push({ distance: hit.distance, point: r.at(hit.distance, new THREE.Vector3()), object: this, instanceId: hit.index } as THREE.Intersection)
    }
  }, [])

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    if (e.instanceId !== undefined) setHovered(e.instanceId)
  }
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.delta > 4) return // ignore clicks that were really camera drags
    if (e.instanceId !== undefined) select(e.instanceId)
  }

  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, undefined, n]}
      castShadow
      receiveShadow
      frustumCulled={false}
      raycast={raycast}
      onPointerMove={onMove}
      onPointerOut={() => setHovered(null)}
      onClick={onClick}
      name="buildings"
    >
      <primitive object={colorAttr} attach="instanceColor" />
      <meshStandardMaterial roughness={0.62} metalness={0.08} />
    </instancedMesh>
  )
}
