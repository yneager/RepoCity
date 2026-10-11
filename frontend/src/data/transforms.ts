// Pure functions that turn API data into what the city renders. Unit-tested in transforms.test.ts.
import type { Column, Layout, Meta, Prediction, Snapshot } from '../api'

export type HeightMode = 'churn' | 'complexity' | 'commits'
export type ColorMode = 'risk' | 'authors' | 'age' | 'bugs'
export type HeatMetric = 'churn' | 'commits' | 'fixes' | 'born'

export const HEIGHT_MODES: { id: HeightMode; label: string; help: string; key: string }[] = [
  { id: 'churn', label: 'Churn', help: 'Lines added + deleted so far', key: '1' },
  { id: 'complexity', label: 'Complexity', help: 'Total cyclomatic complexity', key: '2' },
  { id: 'commits', label: 'Commits', help: 'Commits touching the file so far', key: '3' },
]

export const COLOR_MODES: { id: ColorMode; label: string; help: string; key: string }[] = [
  { id: 'risk', label: 'Predicted risk', help: 'LightGBM bug risk (percentile), trained only on the past', key: '4' },
  { id: 'authors', label: 'Authors', help: 'Distinct authors so far', key: '5' },
  { id: 'age', label: 'Age', help: 'Months since the file was created', key: '6' },
  { id: 'bugs', label: 'Bug history', help: 'Bug-fix commits that touched the file so far', key: '7' },
]

export const HEAT_METRICS: { id: HeatMetric; label: string; help: string; window: number }[] = [
  { id: 'churn', label: 'Churn', help: 'Lines changed in the trailing window', window: 6 },
  { id: 'commits', label: 'Commits', help: 'Commits in the trailing window', window: 6 },
  { id: 'fixes', label: 'Bug fixes', help: 'Bug-fix commits in the trailing window', window: 12 },
  { id: 'born', label: 'Bugs born', help: 'SZZ bug-introducing commits in the trailing window', window: 12 },
]

export type RGB = [number, number, number]

/** Linear interpolation through colour stops (t in [0, 1]). */
export function rampColor(stops: RGB[], t: number): RGB {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const f = x - i
  const a = stops[i]
  const b = stops[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]

export const RISK_STOPS: RGB[] = ['#16a34a', '#84cc16', '#facc15', '#f97316', '#dc2626'].map(hex)
export const SEQ_STOPS: Record<Exclude<ColorMode, 'risk'>, RGB[]> = {
  authors: ['#1e3a5f', '#2563eb', '#7c3aed', '#db2777', '#fde68a'].map(hex),
  age: ['#ecfeff', '#67e8f9', '#0891b2', '#1e40af', '#312e81'].map(hex),
  bugs: ['#334155', '#a16207', '#ea580c', '#dc2626', '#fda4af'].map(hex),
}
/** Heat ramp (inferno-like): quiet = dark violet, hot = pale yellow. */
export const HEAT_STOPS: RGB[] = ['#1a1033', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'].map(hex)
export const NO_DATA: RGB = hex('#64748b')
export const BACKGROUND: RGB = hex('#0f172a')

export function stopsFor(mode: ColorMode): RGB[] {
  return mode === 'risk' ? RISK_STOPS : SEQ_STOPS[mode]
}

export function cssGradientFromStops(s: RGB[]): string {
  const parts = s.map((c, i) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')}) ${(i / (s.length - 1)) * 100}%`)
  return `linear-gradient(90deg, ${parts.join(', ')})`
}

export function cssGradient(mode: ColorMode): string {
  return cssGradientFromStops(stopsFor(mode))
}

export const cssColor = (c: RGB) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`

/** log scaling so that a few giant files do not flatten everyone else */
export function logNorm(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0
  return Math.min(1, Math.log1p(v) / Math.log1p(max))
}

/** Square-root scaling: tall outliers stay tall, but differences among ordinary files remain visible. */
export function sqrtNorm(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0
  return Math.min(1, Math.sqrt(v / max))
}

export function heightValue(snap: Snapshot, i: number, mode: HeightMode): number {
  if (mode === 'churn') return snap.churn[i]
  if (mode === 'complexity') return snap.ccn[i]
  return snap.commits[i]
}

export function heightMax(meta: Meta, mode: HeightMode): number {
  if (mode === 'churn') return meta.maxima.churn
  if (mode === 'complexity') return meta.maxima.ccn
  return meta.maxima.commits
}

/** Building height in world units. Existing files get a small minimum height. */
export function buildingHeight(value: number, max: number, citySize: number): number {
  const maxH = citySize * 0.2
  return citySize * 0.003 + sqrtNorm(value, max) * maxH
}

export function colorValue(snap: Snapshot, i: number, mode: ColorMode, meta: Meta): number {
  switch (mode) {
    case 'risk':
      return snap.risk[i]
    case 'authors':
      return logNorm(snap.authors[i], Math.max(2, meta.maxima.authors))
    case 'age':
      return snap.age[i] / Math.max(1, meta.maxima.age)
    case 'bugs':
      return logNorm(snap.fixes[i], Math.max(2, meta.maxima.fixes))
  }
}

export function buildingColor(snap: Snapshot, i: number, mode: ColorMode, meta: Meta): RGB {
  const v = colorValue(snap, i, mode, meta)
  if (mode === 'risk' && v < 0) return NO_DATA
  return rampColor(stopsFor(mode), v)
}

/** Footprint side lengths: area proportional to current LOC within the file's reserved lot. */
export function footprint(layout: Layout, i: number, loc: number): [number, number] {
  const maxLoc = Math.max(1, layout.files.maxLoc[i])
  const gap = 0.2
  const s = loc > 0 ? Math.max(0.22, Math.sqrt(Math.min(1, loc / maxLoc))) : 0
  return [layout.files.w[i] * (1 - gap) * s, layout.files.d[i] * (1 - gap) * s]
}

// ---- heatmap ------------------------------------------------------------------------------------

function columnFor(snap: Snapshot, metric: HeatMetric): Column {
  if (metric === 'churn') return snap.churn
  if (metric === 'commits') return snap.commits
  if (metric === 'fixes') return snap.fixes
  return snap.bornTotal
}

/** Activity in the trailing window = cumulative value now minus cumulative value at the window start. */
export function heatValues(snap: Snapshot, lag: Snapshot | null, metric: HeatMetric): Float32Array {
  const now = columnFor(snap, metric)
  const before = lag ? columnFor(lag, metric) : null
  const out = new Float32Array(now.length)
  for (let i = 0; i < now.length; i++) {
    if (snap.loc[i] <= 0) continue
    out[i] = Math.max(0, now[i] - (before ? before[i] : 0))
  }
  return out
}

/** 0..1 heat per building (log-scaled against the hottest file); -1 = file does not exist. */
export function heatNormalised(values: Float32Array, loc: Column): Float32Array {
  let max = 0
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i]
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = loc[i] > 0 ? logNorm(values[i], max) : -1
  return out
}

// ---- filters -------------------------------------------------------------------------------------

const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|testing|test-?suite|testsuite)(\/|$)|(^|\/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$|Tests?\.java$/i

export function isTestPath(path: string): boolean {
  return TEST_RE.test(path)
}

export interface Masks {
  hidden: Uint8Array // 1 = not drawn at all
  dimmed: Uint8Array // 1 = drawn faded
  active: boolean
}

/** Hide tests and/or dim files that do not match a path filter or lie outside a focused district. */
export function filterMasks(paths: string[], opts: { hideTests: boolean; pathFilter: string; district: string | null }): Masks {
  const n = paths.length
  const hidden = new Uint8Array(n)
  const dimmed = new Uint8Array(n)
  const q = opts.pathFilter.trim().toLowerCase()
  const prefix = opts.district ? `${opts.district}/` : null
  for (let i = 0; i < n; i++) {
    const p = paths[i]
    if (opts.hideTests && isTestPath(p)) hidden[i] = 1
    if (q && !p.toLowerCase().includes(q)) dimmed[i] = 1
    if (prefix && !p.startsWith(prefix)) dimmed[i] = 1
  }
  return { hidden, dimmed, active: opts.hideTests || !!q || !!prefix }
}

// ---- encoding -------------------------------------------------------------------------------------

export interface Encoded {
  height: Float32Array
  sx: Float32Array
  sz: Float32Array
  color: Float32Array // rgb triplets
}

export interface EncodeOptions {
  heightMode: HeightMode
  colorMode: ColorMode
  /** building-indexed risk percentiles that replace snapshot risk (Prediction vs Reality) */
  riskOverride?: Float32Array | null
  /** building-indexed heat 0..1 (heatmap mode): flattens the city and colours by heat */
  heat?: Float32Array | null
  masks?: Masks | null
}

/** Target geometry and colour of every building for one snapshot. */
export function encodeSnapshot(layout: Layout, meta: Meta, snap: Snapshot, opts: EncodeOptions): Encoded {
  const n = layout.files.id.length
  const out: Encoded = {
    height: new Float32Array(n),
    sx: new Float32Array(n),
    sz: new Float32Array(n),
    color: new Float32Array(n * 3),
  }
  const hmax = heightMax(meta, opts.heightMode)
  const heat = opts.heat ?? null
  const masks = opts.masks ?? null
  for (let i = 0; i < n; i++) {
    const loc = snap.loc[i]
    const hidden = masks?.hidden[i] === 1
    if (loc > 0 && !hidden) {
      const h = buildingHeight(heightValue(snap, i, opts.heightMode), hmax, layout.size)
      // heatmap: a near-flat city whose hottest files still rise a little
      out.height[i] = heat ? layout.size * 0.0025 + Math.max(0, heat[i]) * layout.size * 0.035 : h
      const [w, d] = footprint(layout, i, loc)
      out.sx[i] = w
      out.sz[i] = d
    }
    let c: RGB
    if (heat) {
      c = heat[i] < 0 ? NO_DATA : rampColor(HEAT_STOPS, heat[i])
    } else if (opts.riskOverride) {
      const r = opts.riskOverride[i]
      c = r < 0 ? NO_DATA : rampColor(RISK_STOPS, r)
    } else {
      c = buildingColor(snap, i, opts.colorMode, meta)
    }
    if (masks?.dimmed[i] === 1) c = [c[0] * 0.22 + BACKGROUND[0] * 0.78, c[1] * 0.22 + BACKGROUND[1] * 0.78, c[2] * 0.22 + BACKGROUND[2] * 0.78]
    out.color[i * 3] = c[0]
    out.color[i * 3 + 1] = c[1]
    out.color[i * 3 + 2] = c[2]
  }
  return out
}

/** Building-indexed risk percentiles from a prediction (-1 where no prediction). */
export function riskFromPrediction(p: Prediction, n: number): Float32Array {
  const out = new Float32Array(n).fill(-1)
  p.files.forEach((b, j) => {
    const v = p.riskPct[j]
    out[b] = v == null ? -1 : v
  })
  return out
}

// ---- prediction vs reality -------------------------------------------------------------------------

export interface ScoreCard {
  k: number
  hits: number
  precision: number
  hotspotHits: number
  hotspotPrecision: number
  positives: number
  topK: number[] // building indices
  hotspotTopK: number[]
}

/** hits@k / precision@k for the model and the hotspot baseline, using the exact rank orders
 * (with the backend's seeded tie-breaking) exported with the prediction. */
export function scoreCard(p: Prediction, k: number): ScoreCard {
  const actual = p.actual ?? []
  const kk = Math.min(k, p.files.length)
  const top = p.rankModel.slice(0, kk)
  const topH = p.rankHotspot.slice(0, kk)
  const hits = top.reduce((s, j) => s + (actual[j] ?? 0), 0)
  const hotspotHits = topH.reduce((s, j) => s + (actual[j] ?? 0), 0)
  return {
    k: kk,
    hits,
    precision: kk ? hits / kk : 0,
    hotspotHits,
    hotspotPrecision: kk ? hotspotHits / kk : 0,
    positives: actual.reduce((s, v) => s + v, 0),
    topK: top.map((j) => p.files[j]),
    hotspotTopK: topH.map((j) => p.files[j]),
  }
}

export type CurvePoint = [number, number]

/** Cumulative share of fixed files found (y) against share of LOC read (x) for a reading order. */
export function effortCurve(order: number[], loc: ArrayLike<number>, actual: ArrayLike<number>, maxPoints = 160): CurvePoint[] {
  const n = order.length
  let totalLoc = 0
  let totalPos = 0
  for (let j = 0; j < n; j++) {
    totalLoc += Math.max(1, loc[j])
    totalPos += actual[j]
  }
  if (!n || !totalPos) return [[0, 0], [1, 1]]
  const pts: CurvePoint[] = [[0, 0]]
  let cl = 0
  let cp = 0
  const step = Math.max(1, Math.floor(n / maxPoints))
  for (let r = 0; r < n; r++) {
    const j = order[r]
    cl += Math.max(1, loc[j])
    cp += actual[j]
    if (r % step === 0 || r === n - 1 || actual[j]) pts.push([cl / totalLoc, cp / totalPos])
  }
  return pts
}

/** The best possible reading order (fixed files first, smallest first). */
export function optimalOrder(loc: ArrayLike<number>, actual: ArrayLike<number>): number[] {
  return Array.from({ length: loc.length }, (_, j) => j).sort(
    (a, b) => actual[b] - actual[a] || Math.max(1, loc[a]) - Math.max(1, loc[b]) || a - b,
  )
}

/** Value of a curve at x (linear interpolation), e.g. recall at 20% LOC. */
export function curveAt(curve: CurvePoint[], x: number): number {
  for (let i = 1; i < curve.length; i++) {
    if (curve[i][0] >= x) {
      const [x0, y0] = curve[i - 1]
      const [x1, y1] = curve[i]
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
  }
  return curve.at(-1)?.[1] ?? 0
}

// ---- districts & rankings ----------------------------------------------------------------------------

export interface DistrictStats {
  files: number
  loc: number
  commits: number
  fixes: number
  avgRisk: number | null
  members: number[] // existing building indices, riskiest first
}

export function districtStats(layout: Layout, snap: Snapshot, path: string): DistrictStats {
  const prefix = `${path}/`
  let files = 0
  let loc = 0
  let commits = 0
  let fixes = 0
  let riskSum = 0
  let riskN = 0
  const members: number[] = []
  layout.files.path.forEach((p, i) => {
    if (!p.startsWith(prefix) || snap.loc[i] <= 0) return
    files++
    loc += snap.loc[i]
    commits += snap.commits[i]
    fixes += snap.fixes[i]
    if (snap.risk[i] >= 0) {
      riskSum += snap.risk[i]
      riskN++
    }
    members.push(i)
  })
  members.sort((a, b) => snap.risk[b] - snap.risk[a] || snap.churn[b] - snap.churn[a])
  return { files, loc, commits, fixes, avgRisk: riskN ? riskSum / riskN : null, members }
}

export type RankMetric = 'risk' | 'churn' | 'fixes'

/** Top-n existing (and not hidden) buildings by a metric of the snapshot. */
export function leaderboard(snap: Snapshot, metric: RankMetric, n: number, hidden?: Uint8Array): number[] {
  const col = metric === 'risk' ? snap.risk : metric === 'churn' ? snap.churn : snap.fixes
  const idx: number[] = []
  for (let i = 0; i < snap.loc.length; i++) if (snap.loc[i] > 0 && !(hidden && hidden[i]) && col[i] > (metric === 'risk' ? -1 : 0)) idx.push(i)
  idx.sort((a, b) => col[b] - col[a] || snap.churn[b] - snap.churn[a] || a - b)
  return idx.slice(0, n)
}

// ---- misc ------------------------------------------------------------------------------------------

/** Case-insensitive path search: exact file-name prefix first, then substring, shortest first. */
export function searchPaths(paths: string[], query: string, limit = 10, exists?: (i: number) => boolean): number[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: [number, number][] = []
  for (let i = 0; i < paths.length; i++) {
    if (exists && !exists(i)) continue
    const p = paths[i].toLowerCase()
    const pos = p.indexOf(q)
    if (pos < 0) continue
    const name = p.slice(p.lastIndexOf('/') + 1)
    const score = (name.startsWith(q) ? 0 : name.includes(q) ? 1000 : 2000) + p.length
    scored.push([score, i])
  }
  scored.sort((a, b) => a[0] - b[0])
  return scored.slice(0, limit).map((s) => s[1])
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatMonth(month: string): string {
  return `${MONTH_NAMES[parseInt(month.slice(5, 7), 10) - 1]} ${month.slice(0, 4)}`
}

export function formatNumber(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${Math.round(n)}`
}

export function formatDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

export function addMonths(month: string, n: number): string {
  const y = parseInt(month.slice(0, 4), 10)
  const m = parseInt(month.slice(5, 7), 10) - 1 + n
  const yy = y + Math.floor(m / 12)
  const mm = ((m % 12) + 12) % 12
  return `${yy}-${String(mm + 1).padStart(2, '0')}`
}

/** Exponential smoothing step used by the animations (frame-rate independent). */
export function approach(current: number, target: number, dt: number, rate = 6): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}

export const isValidRepoUrl = (url: string): boolean =>
  /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\-/]+?(\.git)?\/?$/.test(url.trim()) && !url.includes('@') && !url.includes('..')
