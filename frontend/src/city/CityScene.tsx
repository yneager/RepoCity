import { CameraControls, PerformanceMonitor } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Layout, Meta, Snapshot } from '../api'
import { scoreCard } from '../data/transforms'
import { useCity } from '../store'
import { cityAnim } from './anim'
import { Buildings } from './Buildings'
import { DistrictPlates, LabelLayer, LabelProjector, pickLabelDistricts } from './Districts'
import { BugSparks, RevealMarkers, SelectionOutline, TopKOutlines } from './Overlays'

interface Props {
  layout: Layout
  meta: Meta
  snapshot: Snapshot
}

declare global {
  interface Window {
    __repocity?: {
      fps: number[]
      frames: number
      ready: boolean
      buildings: number
      updateMs: number[]
      /** screen position (CSS px) of building i's roof centre - used by the e2e tests */
      screenOf?: (i: number) => { x: number; y: number; visible: boolean }
      /** index of the tallest visible building */
      tallest?: () => number
    }
  }
}

/** Frames-per-second samples for the E7 benchmark (read by Playwright). */
function FpsMeter({ buildings }: { buildings: number }) {
  const acc = useRef({ frames: 0, t: performance.now() })
  useEffect(() => {
    window.__repocity = { fps: [], frames: 0, ready: true, buildings, updateMs: [] }
  }, [buildings])
  useFrame(() => {
    const a = acc.current
    a.frames++
    const now = performance.now()
    if (window.__repocity) window.__repocity.frames++
    if (now - a.t >= 1000) {
      window.__repocity?.fps.push((a.frames * 1000) / (now - a.t))
      a.frames = 0
      a.t = now
    }
  })
  return null
}

/** Exposes projection helpers for end-to-end tests (no effect on rendering). */
function TestHooks() {
  const { camera, gl } = useThree()
  useEffect(() => {
    const v = new THREE.Vector3()
    const api = window.__repocity
    if (!api) return
    api.screenOf = (i: number) => {
      v.set(cityAnim.x[i], cityAnim.base[i] + cityAnim.h[i] * 0.85, cityAnim.z[i]).project(camera)
      const r = gl.domElement.getBoundingClientRect()
      return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height, visible: cityAnim.sx[i] > 0.02 && v.z < 1 }
    }
    api.tallest = () => {
      let best = -1
      for (let i = 0; i < cityAnim.n; i++) if (cityAnim.sx[i] > 0.02 && (best < 0 || cityAnim.h[i] > cityAnim.h[best])) best = i
      return best
    }
  })
  return null
}

function CameraRig({ size }: { size: number }) {
  const controls = useRef<CameraControls>(null)
  const flyNonce = useCity((s) => s.flyNonce)
  const selected = useCity((s) => s.selected)
  const resetNonce = useCity((s) => s.analysisId)

  useEffect(() => {
    const c = controls.current
    if (!c) return
    const mid = size / 2
    void c.setLookAt(mid + size * 0.58, size * 0.86, mid + size * 1.2, mid - size * 0.04, 0, mid + size * 0.04, false)
  }, [size, resetNonce])

  useEffect(() => {
    const c = controls.current
    if (!c || selected == null || flyNonce === 0) return
    const i = selected
    const x = cityAnim.x[i]
    const z = cityAnim.z[i]
    const h = cityAnim.base[i] + cityAnim.h[i]
    const d = Math.max(size * 0.07, h * 1.6, Math.max(cityAnim.sx[i], cityAnim.sz[i]) * 4)
    void c.setLookAt(x + d * 0.7, h + d * 0.8, z + d * 0.95, x, h * 0.5, z, true)
  }, [flyNonce, selected, size])

  return (
    <CameraControls
      ref={controls}
      makeDefault
      minDistance={size * 0.01}
      maxDistance={size * 3}
      maxPolarAngle={Math.PI * 0.47}
      dollySpeed={0.6}
      smoothTime={0.35}
    />
  )
}

function Scene({ layout, meta, snapshot, lowQuality }: Props & { lowQuality: boolean }) {
  const size = layout.size
  const mode = useCity((s) => s.mode)
  const prediction = useCity((s) => s.prediction)
  const revealed = useCity((s) => s.revealed)
  const k = useCity((s) => s.pvrK)
  const selected = useCity((s) => s.selected)
  const playing = useCity((s) => s.playing)
  const labelDistricts = useMemo(() => pickLabelDistricts(layout.districts), [layout])

  const pvr = useMemo(() => {
    if (mode !== 'pvr' || !prediction) return null
    const card = scoreCard(prediction, k)
    const positives = prediction.actual ? prediction.files.filter((_, j) => prediction.actual![j] === 1) : []
    return { topK: card.topK, positives, hits: new Set(card.topK.filter((b) => positives.includes(b))) }
  }, [mode, prediction, k])

  const mid = size / 2
  return (
    <>
      <color attach="background" args={['#070b14']} />
      <fog attach="fog" args={['#070b14', size * 1.4, size * 4]} />
      <hemisphereLight args={['#c7d2fe', '#0b1220', 0.75]} />
      <ambientLight intensity={0.18} />
      <directionalLight
        position={[mid + size * 0.55, size * 1.1, mid + size * 0.3]}
        intensity={2.1}
        castShadow={!lowQuality}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-size * 0.8}
        shadow-camera-right={size * 0.8}
        shadow-camera-top={size * 0.8}
        shadow-camera-bottom={-size * 0.8}
        shadow-camera-near={1}
        shadow-camera-far={size * 4}
      >
        <object3D attach="target" position={[mid, 0, mid]} />
      </directionalLight>
      <directionalLight position={[mid - size, size * 0.4, mid - size * 0.6]} intensity={0.35} color="#93c5fd" />
      <mesh rotation-x={-Math.PI / 2} position={[mid, -0.05, mid]} receiveShadow raycast={() => null}>
        <planeGeometry args={[size * 12, size * 12]} />
        <meshStandardMaterial color="#0a101d" roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[mid, 0, mid]} receiveShadow raycast={() => null}>
        <planeGeometry args={[size * 1.02, size * 1.02]} />
        <meshStandardMaterial color="#0f172a" roughness={1} />
      </mesh>
      <DistrictPlates layout={layout} />
      <Buildings layout={layout} meta={meta} snapshot={snapshot} />
      <SelectionOutline index={selected} size={size} />
      {pvr && <TopKOutlines indices={pvr.topK} size={size} />}
      {pvr && revealed && <RevealMarkers indices={pvr.positives} hits={pvr.hits} size={size} />}
      <BugSparks born={snapshot.born} enabled={playing && mode === 'explore'} size={size} />
      <LabelProjector districts={labelDistricts} size={size} />
      <CameraRig size={size} />
      <FpsMeter buildings={layout.files.id.length} />
      <TestHooks />
    </>
  )
}

/** Quality is adaptive: if the frame rate keeps declining, shadows are switched off and the
 * pixel ratio drops to 1 (`?quality=high` or `?quality=low` forces a level). */
function initialQuality(): 'auto' | 'high' | 'low' {
  const q = new URLSearchParams(window.location.search).get('quality')
  return q === 'high' || q === 'low' ? q : 'auto'
}

export function CityScene(props: Props) {
  const labelDistricts = useMemo(() => pickLabelDistricts(props.layout.districts), [props.layout])
  const setHovered = useCity((s) => s.setHovered)
  const [forced] = useState(initialQuality)
  const [degraded, setDegraded] = useState(forced === 'low')
  const lowQuality = forced === 'low' || (forced === 'auto' && degraded)
  return (
    <div className="absolute inset-0" data-testid="city-canvas">
      <Canvas
        shadows
        dpr={lowQuality ? 1 : [1, 1.75]}
        camera={{ fov: 45, near: 1, far: props.layout.size * 20, position: [1500, 800, 1500] }}
        gl={{ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
        onPointerMissed={() => setHovered(null)}
      >
        {forced === 'auto' && <PerformanceMonitor flipflops={1} onDecline={() => setDegraded(true)} />}
        <Scene {...props} lowQuality={lowQuality} />
      </Canvas>
      {lowQuality && (
        <div className="pointer-events-none absolute bottom-[104px] right-4 rounded-md bg-slate-900/70 px-2 py-1 text-[10.5px] text-slate-400" data-testid="low-quality">
          reduced quality (shadows off) for smoother rendering
        </div>
      )}
      <LabelLayer districts={labelDistricts} />
    </div>
  )
}
