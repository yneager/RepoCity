import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { District, Layout } from '../api'
import { districtColor, plateHeight } from './geometry'

/** One instanced slab per directory district, stacked by nesting depth. */
export function DistrictPlates({ layout }: { layout: Layout }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const ds = layout.districts
  const ph = plateHeight(layout.size)
  const geometry = useMemo(() => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    g.translate(0.5, 0.5, 0.5) // origin at the min corner
    return g
  }, [])
  const colors = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, ds.length) * 3), 3)
    ds.forEach((d, i) => a.setXYZ(i, ...districtColor(d.depth)))
    return a
  }, [ds])

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
  }, [ds, ph])

  if (!ds.length) return null
  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, ds.length]} receiveShadow raycast={() => null}>
      <primitive object={colors} attach="instanceColor" />
      <meshStandardMaterial roughness={0.95} metalness={0} />
    </instancedMesh>
  )
}

// ---- labels: DOM nodes positioned by projecting district anchors every frame -------------------

export const labelNodes: (HTMLDivElement | null)[] = []

export function pickLabelDistricts(ds: District[], max = 90): District[] {
  return [...ds]
    .filter((d) => d.depth <= 5)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, max)
}

export function LabelLayer({ districts }: { districts: District[] }) {
  labelNodes.length = districts.length
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {districts.map((d, i) => (
        <div
          key={d.path}
          ref={(el) => {
            labelNodes[i] = el
          }}
          className={`district-label ${d.depth <= 1 ? 'district-label--top' : ''}`}
          style={{ opacity: 0 }}
        >
          {d.label}
        </div>
      ))}
    </div>
  )
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Inside the Canvas: fades labels in when their district is big enough on screen, out when huge. */
export function LabelProjector({ districts, size }: { districts: District[]; size: number }) {
  const { camera, size: viewport } = useThree()
  const v = useMemo(() => new THREE.Vector3(), [])
  const ph = plateHeight(size)
  useFrame(() => {
    const cam = camera as THREE.PerspectiveCamera
    const focal = viewport.height / 2 / Math.tan((cam.fov * Math.PI) / 360)
    for (let i = 0; i < districts.length; i++) {
      const el = labelNodes[i]
      if (!el) continue
      const d = districts[i]
      v.set(d.x + d.w / 2, d.depth * ph, d.y + Math.min(d.h * 0.08, size * 0.012))
      const dist = v.distanceTo(cam.position)
      const px = (d.w / Math.max(dist, 1)) * focal
      v.project(cam)
      const onScreen = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1
      const opacity = onScreen ? smooth(70, 150, px) * (1 - smooth(1600, 2600, px)) : 0
      el.style.opacity = opacity.toFixed(2)
      if (opacity > 0) {
        const sx = (v.x * 0.5 + 0.5) * viewport.width
        const sy = (-v.y * 0.5 + 0.5) * viewport.height
        el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%)`
        el.style.maxWidth = `${Math.max(60, px * 0.95).toFixed(0)}px`
      }
    }
  })
  return null
}
