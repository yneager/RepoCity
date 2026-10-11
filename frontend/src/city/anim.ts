// Shared, mutable per-building animation state. Written by <Buildings/> every frame and read by
// overlays (selection outline, markers, labels) so they follow the animated geometry exactly.
// Kept outside React state on purpose: updating 20k values per frame through React would be far too slow.

export interface CityAnim {
  n: number
  x: Float32Array
  z: Float32Array
  base: Float32Array // y of the ground the building stands on (top of its district plate)
  h: Float32Array
  sx: Float32Array
  sz: Float32Array
  version: number
}

export const cityAnim: CityAnim = {
  n: 0,
  x: new Float32Array(0),
  z: new Float32Array(0),
  base: new Float32Array(0),
  h: new Float32Array(0),
  sx: new Float32Array(0),
  sz: new Float32Array(0),
  version: 0,
}

export function resetAnim(x: Float32Array, z: Float32Array, base: Float32Array): void {
  const n = x.length
  cityAnim.n = n
  cityAnim.x = x
  cityAnim.z = z
  cityAnim.base = base
  cityAnim.h = new Float32Array(n)
  cityAnim.sx = new Float32Array(n)
  cityAnim.sz = new Float32Array(n)
  cityAnim.version++
}

export function topOf(i: number): [number, number, number] {
  return [cityAnim.x[i], cityAnim.base[i] + cityAnim.h[i], cityAnim.z[i]]
}
