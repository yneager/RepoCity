import type { Layout } from '../api'

/** Height of one district plate level (world units). */
export const plateHeight = (size: number) => size * 0.0016

/** Depth of the innermost district containing each file (0 = city root). */
export function fileDepths(layout: Layout): Int32Array {
  const depthOf = new Map(layout.districts.map((d) => [d.path, d.depth]))
  const out = new Int32Array(layout.files.path.length)
  layout.files.path.forEach((p, i) => {
    let dir = p
    let depth = 0
    for (;;) {
      const cut = dir.lastIndexOf('/')
      if (cut < 0) break
      dir = dir.slice(0, cut)
      const d = depthOf.get(dir)
      if (d !== undefined) {
        depth = d
        break
      }
    }
    out[i] = depth
  })
  return out
}

export function buildingBases(layout: Layout): Float32Array {
  const ph = plateHeight(layout.size)
  const depths = fileDepths(layout)
  return Float32Array.from(depths, (d) => d * ph)
}

export function districtColor(depth: number): [number, number, number] {
  // dark slate plates, slightly lighter for deeper levels
  const l = 0.085 + Math.min(depth, 8) * 0.022
  return [l * 0.92, l * 1.02, l * 1.25]
}
