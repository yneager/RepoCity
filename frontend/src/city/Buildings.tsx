import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Layout, Meta, Snapshot } from '../api'
import { approach, encodeSnapshot, riskFromPrediction, type Encoded } from '../data/transforms'
import { useCity } from '../store'
import { cityAnim, resetAnim } from './anim'
import { buildingBases } from './geometry'

const HOVER_MIX = 0.35

interface Props {
  layout: Layout
  meta: Meta
  snapshot: Snapshot
}

/**
 * All buildings in a single InstancedMesh (one draw call). Every frame, current height,
 * footprint and colour approach their targets with exponential smoothing; instance matrices
 * are written straight into the Float32Array (no Object3D per building), which keeps 20k+
 * buildings at interactive frame rates.
 */
export function Buildings({ layout, meta, snapshot }: Props) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const n = layout.files.id.length
  const heightMode = useCity((s) => s.heightMode)
  const colorMode = useCity((s) => s.colorMode)
  const mode = useCity((s) => s.mode)
  const prediction = useCity((s) => s.prediction)
  const hovered = useCity((s) => s.hovered)
  const setHovered = useCity((s) => s.setHovered)
  const select = useCity((s) => s.select)

  const state = useMemo(() => {
    const x = Float32Array.from(layout.files.x)
    const z = Float32Array.from(layout.files.z)
    resetAnim(x, z, buildingBases(layout))
    return { color: new Float32Array(n * 3).fill(0.3), target: null as Encoded | null, active: true, hovered: -1 }
  }, [layout, n])

  const geometry = useMemo(() => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    g.translate(0, 0.5, 0) // base at y = 0 so scaling grows upwards
    return g
  }, [])

  useEffect(() => {
    const riskOverride = mode === 'pvr' && prediction ? riskFromPrediction(prediction, n) : null
    state.target = encodeSnapshot(layout, meta, snapshot, heightMode, colorMode, riskOverride)
    state.active = true
  }, [layout, meta, snapshot, heightMode, colorMode, mode, prediction, n, state])

  useEffect(() => {
    state.hovered = hovered ?? -1
    state.active = true
  }, [hovered, state])

  // instance colours must exist before the material's shader is compiled
  const colorAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [n])

  useEffect(() => {
    mesh.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  }, [n])

  useFrame((_, delta) => {
    const m = mesh.current
    const t = state.target
    if (!m || !t || !state.active || !m.instanceColor) return
    const dt = Math.min(delta, 0.1)
    const { x, z, base, h, sx, sz } = cityAnim
    const mat = m.instanceMatrix.array as Float32Array
    const col = m.instanceColor.array as Float32Array
    const cur = state.color
    let moving = false
    for (let i = 0; i < n; i++) {
      const th = t.height[i]
      const nh = approach(h[i], th, dt, 5)
      const nsx = approach(sx[i], t.sx[i], dt, 7)
      const nsz = approach(sz[i], t.sz[i], dt, 7)
      if (Math.abs(nh - th) > 0.01 || Math.abs(nsx - t.sx[i]) > 0.01 || Math.abs(nsz - t.sz[i]) > 0.01) moving = true
      h[i] = Math.abs(nh - th) < 0.01 ? th : nh
      sx[i] = Math.abs(nsx - t.sx[i]) < 0.01 ? t.sx[i] : nsx
      sz[i] = Math.abs(nsz - t.sz[i]) < 0.01 ? t.sz[i] : nsz
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
      for (let k = 0; k < 3; k++) {
        const nc = approach(cur[c + k], t.color[c + k], dt, 6)
        if (Math.abs(nc - t.color[c + k]) > 0.004) moving = true
        cur[c + k] = nc
        col[c + k] = i === state.hovered ? nc + (1 - nc) * HOVER_MIX : nc
      }
    }
    m.instanceMatrix.needsUpdate = true
    m.instanceColor.needsUpdate = true
    cityAnim.version++
    if (!moving) {
      state.active = false
      m.computeBoundingSphere()
      m.computeBoundingBox()
    }
  })

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    if (e.instanceId !== undefined && e.instanceId !== hovered) setHovered(e.instanceId)
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
