// Synthetic city for the frontend FPS benchmark (experiment E7): open  /#/bench/20000
import { useEffect, useMemo, useState } from 'react'
import type { Layout, Meta, Snapshot } from './api'
import { CityScene } from './city/CityScene'
import { useCity } from './store'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export function syntheticCity(n: number): { layout: Layout; meta: Meta; snaps: Snapshot[] } {
  const r = rng(42)
  const side = Math.ceil(Math.sqrt(n))
  const size = 1000
  const cell = size / side
  const files = { id: [] as number[], path: [] as string[], x: [] as number[], z: [] as number[], w: [] as number[], d: [] as number[], maxLoc: [] as number[] }
  for (let i = 0; i < n; i++) {
    const gx = i % side
    const gz = Math.floor(i / side)
    files.id.push(i)
    files.path.push(`dir${Math.floor(gz / 8)}/sub${Math.floor(gx / 8)}/file${i}.py`)
    files.x.push((gx + 0.5) * cell)
    files.z.push((gz + 0.5) * cell)
    files.w.push(cell * 0.9)
    files.d.push(cell * 0.9)
    files.maxLoc.push(100 + Math.floor(r() * 2000))
  }
  const districts = Array.from({ length: Math.ceil(side / 8) }, (_, k) => ({
    path: `dir${k}`, label: `dir${k}`, x: 0, y: k * 8 * cell, w: size, h: Math.min(8 * cell, size - k * 8 * cell), depth: 1,
  }))
  const layout: Layout = { size, files, districts }
  const mk = (phase: number): Snapshot => {
    const arr = (f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i))
    return {
      month: phase ? '2020-02' : '2020-01', riskCutoff: '2020-01',
      loc: arr((i) => Math.floor(files.maxLoc[i] * (0.5 + 0.5 * ((i * 7 + phase * 3) % 10) / 10))),
      ccn: arr((i) => (i * 13) % 200), churn: arr((i) => ((i * 31 + phase * 977) % 5000)), commits: arr((i) => (i * 17 + phase * 5) % 300),
      authors: arr((i) => 1 + (i % 9)), age: arr((i) => i % 120), fixes: arr((i) => i % 15), bornTotal: arr(() => 0), born: arr(() => 0),
      risk: arr((i) => ((i * 7919 + phase * 104729) % 1000) / 1000),
    }
  }
  const meta = {
    id: 'bench', name: `benchmark (${n} buildings)`, url: null, head: '0000000', webUrl: null, months: ['2020-01', '2020-02'],
    firstCommit: 0, lastCommit: 0, nCommits: 0, nBugfixes: 0, nFiles: n, nBuildingsLast: n, locLast: 0, cutoffs: [], evalCutoffs: [],
    horizonMonths: 6, topK: 20, maxima: { churn: 5000, commits: 300, ccn: 200, authors: 9, age: 120, fixes: 15, loc: 2100 },
    featureLabels: {}, featureGroups: {}, methodLabels: {}, metricLabels: {},
  } satisfies Meta
  return { layout, meta, snaps: [mk(0), mk(1)] }
}

/** Alternates between two snapshots every 0.6 s so buildings animate continuously. */
export function BenchView({ n }: { n: number }) {
  const { layout, meta, snaps } = useMemo(() => syntheticCity(n), [n])
  const [k, setK] = useState(0)
  useEffect(() => {
    useCity.setState({ meta, layout, analysisId: 'bench' })
    const t = setInterval(() => setK((v) => 1 - v), 600)
    return () => clearInterval(t)
  }, [layout, meta])
  return (
    <div className="relative h-full" data-testid="bench">
      <CityScene layout={layout} meta={meta} snapshot={snaps[k]} bench />
      <div className="panel absolute left-3 top-3 px-3 py-2 text-[13px]">{n} buildings</div>
    </div>
  )
}
