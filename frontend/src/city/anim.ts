// Shared, mutable per-building animation state. Written by <Buildings/> every frame and read by
// overlays (selection outline, markers, labels, minimap, picking) so they follow the animated
// geometry exactly. Kept outside React state on purpose: pushing 20k values per frame through
// React would be far too slow.

export interface CityAnim {
  n: number
  size: number
  x: Float32Array
  z: Float32Array
  base: Float32Array // y of the ground the building stands on (top of its district plate)
  h: Float32Array
  sx: Float32Array
  sz: Float32Array
  /** currently displayed colour (rgb triplets) */
  color: Float32Array
  version: number
  /** camera position and look-at target on the ground plane (for the minimap) */
  camera: { x: number; z: number; tx: number; tz: number }
}

export const cityAnim: CityAnim = {
  n: 0,
  size: 1000,
  x: new Float32Array(0),
  z: new Float32Array(0),
  base: new Float32Array(0),
  h: new Float32Array(0),
  sx: new Float32Array(0),
  sz: new Float32Array(0),
  color: new Float32Array(0),
  version: 0,
  camera: { x: 0, z: 0, tx: 0, tz: 0 },
}

export function resetAnim(x: Float32Array, z: Float32Array, base: Float32Array, size: number): void {
  const n = x.length
  cityAnim.n = n
  cityAnim.size = size
  cityAnim.x = x
  cityAnim.z = z
  cityAnim.base = base
  cityAnim.h = new Float32Array(n)
  cityAnim.sx = new Float32Array(n)
  cityAnim.sz = new Float32Array(n)
  cityAnim.color = new Float32Array(n * 3).fill(0.15)
  cityAnim.version++
}

export function topOf(i: number): [number, number, number] {
  return [cityAnim.x[i], cityAnim.base[i] + cityAnim.h[i], cityAnim.z[i]]
}

/**
 * Ray / axis-aligned box picking over all buildings (slab method on typed arrays).
 * Much cheaper than three.js's per-instance matrix raycast for tens of thousands of buildings.
 * Returns the nearest building index and distance, or null.
 */
export function pickBuilding(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, skip?: (i: number) => boolean,
): { index: number; distance: number } | null {
  const { n, x, z, base, h, sx, sz } = cityAnim
  const ix = 1 / (dx || 1e-12)
  const iy = 1 / (dy || 1e-12)
  const iz = 1 / (dz || 1e-12)
  let best = -1
  let bestT = Infinity
  for (let i = 0; i < n; i++) {
    const w = sx[i]
    if (w <= 0.02 || h[i] <= 0.02) continue
    if (skip && skip(i)) continue
    const hw = w * 0.5
    const hd = sz[i] * 0.5
    let t1 = (x[i] - hw - ox) * ix
    let t2 = (x[i] + hw - ox) * ix
    let tmin = Math.min(t1, t2)
    let tmax = Math.max(t1, t2)
    t1 = (base[i] - oy) * iy
    t2 = (base[i] + h[i] - oy) * iy
    tmin = Math.max(tmin, Math.min(t1, t2))
    tmax = Math.min(tmax, Math.max(t1, t2))
    if (tmax < tmin) continue
    t1 = (z[i] - hd - oz) * iz
    t2 = (z[i] + hd - oz) * iz
    tmin = Math.max(tmin, Math.min(t1, t2))
    tmax = Math.min(tmax, Math.max(t1, t2))
    if (tmax < Math.max(tmin, 0)) continue
    const t = tmin > 0 ? tmin : tmax
    if (t < bestT) {
      bestT = t
      best = i
    }
  }
  return best < 0 ? null : { index: best, distance: bestT }
}
