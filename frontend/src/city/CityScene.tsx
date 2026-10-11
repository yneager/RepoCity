import { CameraControls, PerformanceMonitor } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { Layout, Meta, Snapshot } from '../api'
import { filterMasks, scoreCard } from '../data/transforms'
import { MOTION, useSettings } from '../motion'
import { useCity } from '../store'
import { cityAnim } from './anim'
import { Buildings } from './Buildings'
import { setCapture } from './capture'
import { DistrictPlates, LabelLayer, LabelProjector, pickLabelDistricts } from './Districts'
import { BugSparks, RevealMarkers, SelectionOutline, TopKOutlines } from './Overlays'

interface Props {
  layout: Layout
  meta: Meta
  snapshot: Snapshot
  /** benchmark mode: render continuously so frame rates can be measured */
  bench?: boolean
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
      /** true while buildings or the camera are still moving */
      busy?: () => boolean
    }
  }
}

/** Frames-per-second samples for the E7 benchmark (read by Playwright). */
function FpsMeter({ buildings }: { buildings: number }) {
  const acc = useRef({ frames: 0, t: performance.now() })
  const lastFrame = useRef(performance.now())
  useEffect(() => {
    window.__repocity = { fps: [], frames: 0, ready: true, buildings, updateMs: [] }
  }, [buildings])
  useFrame(() => {
    const a = acc.current
    a.frames++
    const now = performance.now()
    lastFrame.current = now
    if (window.__repocity) {
      window.__repocity.frames++
      window.__repocity.busy = () => performance.now() - lastFrame.current < 250
    }
    if (now - a.t >= 1000) {
      window.__repocity?.fps.push((a.frames * 1000) / (now - a.t))
      a.frames = 0
      a.t = now
    }
  })
  return null
}

/** Exposes projection helpers for end-to-end tests and the screenshot capture (no effect on rendering). */
function Hooks() {
  const { camera, gl, scene } = useThree()
  useEffect(() => {
    const v = new THREE.Vector3()
    setCapture(() => {
      gl.render(scene, camera)
      return gl.domElement.toDataURL('image/png')
    })
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

function homePose(size: number): [number, number, number, number, number, number] {
  const mid = size / 2
  return [mid + size * 0.58, size * 0.86, mid + size * 1.2, mid - size * 0.04, 0, mid + size * 0.04]
}

function CameraRig({ size }: { size: number }) {
  const controls = useRef<CameraControls>(null)
  const invalidate = useThree((s) => s.invalidate)
  const flyNonce = useCity((s) => s.flyNonce)
  const flyTarget = useCity((s) => s.flyTarget)
  const selected = useCity((s) => s.selected)
  const analysisId = useCity((s) => s.analysisId)
  const resetNonce = useCity((s) => s.resetNonce)
  const mode = useCity((s) => s.mode)
  const motion = useSettings((s) => s.motion)
  const autoOrbit = useSettings((s) => s.autoOrbit)
  const prevMode = useRef(mode)

  useEffect(() => {
    const c = controls.current
    if (c) c.smoothTime = MOTION[motion].camera
  }, [motion])

  // intro: glide in from high above when a city opens
  useEffect(() => {
    const c = controls.current
    if (!c) return
    const mid = size / 2
    const animate = motion !== 'reduced'
    if (animate) void c.setLookAt(mid + size * 1.7, size * 2.6, mid + size * 2.6, mid, 0, mid, false)
    const pose = homePose(size)
    const id = window.setTimeout(() => void c.setLookAt(...pose, animate), animate ? 60 : 0)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, analysisId])

  useEffect(() => {
    if (resetNonce === 0) return
    void controls.current?.setLookAt(...homePose(size), true)
  }, [resetNonce, size])

  // heatmap = look down on the city like a map; leaving it returns to the oblique view
  useEffect(() => {
    const c = controls.current
    const prev = prevMode.current
    prevMode.current = mode
    if (!c || prev === mode) return
    const mid = size / 2
    if (mode === 'heatmap') void c.setLookAt(mid + size * 0.04, size * 1.55, mid + size * 0.32, mid, 0, mid, true)
    else if (prev === 'heatmap') void c.setLookAt(...homePose(size), true)
  }, [mode, size])

  useEffect(() => {
    const c = controls.current
    if (!c || flyNonce === 0) return
    if (flyTarget) {
      const d = flyTarget.distance
      void c.setLookAt(flyTarget.x + d * 0.45, flyTarget.y + d * 0.75, flyTarget.z + d * 0.62, flyTarget.x, flyTarget.y, flyTarget.z, true)
      return
    }
    if (selected == null) return
    const i = selected
    const x = cityAnim.x[i]
    const z = cityAnim.z[i]
    const h = cityAnim.base[i] + cityAnim.h[i]
    const d = Math.max(size * 0.07, h * 1.6, Math.max(cityAnim.sx[i], cityAnim.sz[i]) * 4)
    void c.setLookAt(x + d * 0.7, h + d * 0.8, z + d * 0.95, x, h * 0.5, z, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyNonce])

  const tgt = useMemo(() => new THREE.Vector3(), [])
  useFrame((state, dt) => {
    const c = controls.current
    if (!c) return
    if (autoOrbit) {
      c.azimuthAngle += Math.min(dt, 0.1) * 0.07
      invalidate()
    }
    c.getTarget(tgt)
    cityAnim.camera.x = state.camera.position.x
    cityAnim.camera.z = state.camera.position.z
    cityAnim.camera.tx = tgt.x
    cityAnim.camera.tz = tgt.z
  })

  useEffect(() => {
    if (autoOrbit) invalidate()
  }, [autoOrbit, invalidate])

  return (
    <CameraControls
      ref={controls}
      makeDefault
      minDistance={size * 0.01}
      maxDistance={size * 3.2}
      maxPolarAngle={Math.PI * 0.47}
      dollySpeed={0.5}
      smoothTime={MOTION[motion].camera}
      draggingSmoothTime={Math.min(0.25, MOTION[motion].camera * 0.3)}
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
  const showHotspot = useCity((s) => s.showHotspotTopK)
  const pathFilter = useCity((s) => s.pathFilter)
  const hideTests = useCity((s) => s.hideTests)
  const selectedDistrict = useCity((s) => s.selectedDistrict)
  const showSparks = useSettings((s) => s.showSparks)
  const picks = useMemo(() => pickLabelDistricts(layout.districts), [layout])
  const district = selectedDistrict != null ? layout.districts[selectedDistrict]?.path ?? null : null
  const masks = useMemo(() => {
    const m = filterMasks(layout.files.path, { hideTests, pathFilter, district })
    return m.active ? m : null
  }, [layout, hideTests, pathFilter, district])

  const pvr = useMemo(() => {
    if (mode !== 'pvr' || !prediction) return null
    const card = scoreCard(prediction, k)
    const positives = prediction.actual ? prediction.files.filter((_, j) => prediction.actual![j] === 1) : []
    const pos = new Set(positives)
    return { topK: card.topK, hotspotTopK: card.hotspotTopK, positives, hits: new Set(card.topK.filter((b) => pos.has(b))) }
  }, [mode, prediction, k])

  const mid = size / 2
  return (
    <>
      <color attach="background" args={['#070b14']} />
      <fog attach="fog" args={['#070b14', size * 1.6, size * 4.5]} />
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
      <Buildings layout={layout} meta={meta} snapshot={snapshot} masks={masks} />
      <SelectionOutline index={selected} size={size} />
      {pvr && <TopKOutlines indices={pvr.topK} size={size} />}
      {pvr && showHotspot && <TopKOutlines indices={pvr.hotspotTopK} size={size} color="#22d3ee" grow={1.34} />}
      {pvr && revealed && <RevealMarkers indices={pvr.positives} hits={pvr.hits} size={size} />}
      <BugSparks born={snapshot.born} enabled={playing && mode !== 'pvr' && showSparks} size={size} />
      <LabelProjector layout={layout} picks={picks} />
      <CameraRig size={size} />
      <FpsMeter buildings={layout.files.id.length} />
      <Hooks />
    </>
  )
}

export function CityScene(props: Props) {
  const picks = useMemo(() => pickLabelDistricts(props.layout.districts), [props.layout])
  const setHovered = useCity((s) => s.setHovered)
  const setHoveredDistrict = useCity((s) => s.setHoveredDistrict)
  const quality = useSettings((s) => s.quality)
  const [degraded, setDegraded] = useState(false)
  const lowQuality = quality === 'low' || (quality === 'auto' && degraded)
  return (
    <div className="absolute inset-0" data-testid="city-canvas">
      <Canvas
        shadows="percentage"
        frameloop={props.bench ? 'always' : 'demand'}
        dpr={lowQuality ? 1 : [1, 1.75]}
        camera={{ fov: 45, near: 1, far: props.layout.size * 20, position: [3000, 2500, 3000] }}
        gl={{ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
        onPointerMissed={() => {
          setHovered(null)
          setHoveredDistrict(null)
        }}
      >
        {quality === 'auto' && <PerformanceMonitor flipflops={1} onDecline={() => setDegraded(true)} />}
        <Scene {...props} lowQuality={lowQuality} />
      </Canvas>
      {lowQuality && (
        <div className="pointer-events-none absolute bottom-[112px] right-4 rounded-md bg-slate-900/70 px-2 py-1 text-[10.5px] text-slate-400" data-testid="low-quality">
          reduced quality (shadows off) for smoother rendering
        </div>
      )}
      <LabelLayer layout={props.layout} picks={picks} />
    </div>
  )
}
