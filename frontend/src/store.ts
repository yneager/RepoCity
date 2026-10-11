import { create } from 'zustand'
import {
  api,
  SNAPSHOT_COLUMNS,
  type FileDetail,
  type Layout,
  type Meta,
  type MonthStats,
  type Prediction,
  type Snapshot,
} from './api'
import { HEAT_METRICS, type ColorMode, type HeatMetric, type HeightMode } from './data/transforms'

export type Mode = 'explore' | 'heatmap' | 'pvr'

/** Where the camera should fly next (world coordinates of the look-at point + distance). */
export interface FlyTarget {
  x: number
  y: number
  z: number
  distance: number
  /** top-down-ish view (heatmap) */
  overhead?: boolean
}

interface CityState {
  analysisId: string | null
  meta: Meta | null
  layout: Layout | null
  monthStats: MonthStats[]
  loading: boolean
  error: string | null

  monthIndex: number // requested month
  snapshot: Snapshot | null // displayed snapshot (the latest one that finished loading)
  snapshotsLoaded: number

  heightMode: HeightMode
  colorMode: ColorMode
  mode: Mode
  playing: boolean
  speed: number // months per second
  loop: boolean

  heatMetric: HeatMetric
  lagSnapshot: Snapshot | null

  hovered: number | null
  selected: number | null
  hoveredDistrict: number | null
  selectedDistrict: number | null
  flyTarget: FlyTarget | null
  flyNonce: number
  resetNonce: number
  /** incremented when the encoding changes: buildings animate in a wave from the centre */
  waveNonce: number
  fileDetail: FileDetail | null
  fileLoading: boolean

  pathFilter: string
  hideTests: boolean

  pvrCutoff: string | null
  pvrK: number
  prediction: Prediction | null
  predictionLoading: boolean
  revealed: boolean
  showHotspotTopK: boolean

  load: (id: string) => Promise<void>
  reset: () => void
  setMonthIndex: (i: number) => void
  setHeightMode: (m: HeightMode) => void
  setColorMode: (m: ColorMode) => void
  setPlaying: (p: boolean) => void
  togglePlay: () => void
  setSpeed: (s: number) => void
  setLoop: (l: boolean) => void
  setHovered: (i: number | null) => void
  select: (i: number | null, fly?: boolean) => void
  setHoveredDistrict: (i: number | null) => void
  selectDistrict: (i: number | null, fly?: boolean) => void
  flyTo: (t: FlyTarget) => void
  flyToSelected: () => void
  resetView: () => void
  setPathFilter: (q: string) => void
  setHideTests: (b: boolean) => void
  setMode: (m: Mode) => void
  setHeatMetric: (m: HeatMetric) => void
  setPvrCutoff: (c: string) => Promise<void>
  stepPvrCutoff: (delta: number) => void
  setPvrK: (k: number) => void
  setRevealed: (r: boolean) => void
  setShowHotspotTopK: (b: boolean) => void
}

// ---- snapshot cache --------------------------------------------------------------------------------
// Lives outside React state. Snapshots are converted to typed arrays (4 bytes per value) and kept in an
// LRU map whose capacity follows a memory budget, so 20k-file cities do not exhaust the tab's memory.

const MEMORY_BUDGET_BYTES = 160e6
const cache = new Map<string, Snapshot>()
const inflight = new Map<string, Promise<Snapshot>>()
let capacity = Infinity
let prefetchToken = 0
let prefetchCentre = 0

export function cachedSnapshot(month: string): Snapshot | undefined {
  const s = cache.get(month)
  if (s) {
    cache.delete(month) // refresh LRU position
    cache.set(month, s)
  }
  return s
}

function toTyped(raw: Snapshot): Snapshot {
  const out = { ...raw } as Snapshot
  for (const col of SNAPSHOT_COLUMNS) {
    const v = raw[col] as ArrayLike<number>
    ;(out as unknown as Record<string, ArrayLike<number>>)[col] = col === 'risk' ? Float32Array.from(v) : Int32Array.from(v)
  }
  return out
}

function remember(month: string, s: Snapshot): void {
  cache.set(month, s)
  while (cache.size > capacity) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function getSnapshot(id: string, month: string): Promise<Snapshot> {
  const hit = cachedSnapshot(month)
  if (hit) return Promise.resolve(hit)
  let p = inflight.get(month)
  if (!p) {
    p = api.snapshot(id, month).then((raw) => {
      const s = toTyped(raw)
      remember(month, s)
      inflight.delete(month)
      return s
    })
    p.catch(() => inflight.delete(month))
    inflight.set(month, p)
  }
  return p
}

const heatWindow = (m: HeatMetric) => HEAT_METRICS.find((h) => h.id === m)?.window ?? 6

export const useCity = create<CityState>((set, get) => {
  async function prefetchAround(id: string, months: string[], centre: number) {
    const token = ++prefetchToken
    prefetchCentre = centre
    // nearest months first, so scrubbing around the current month is instant
    const order = months
      .map((m, i) => [Math.abs(i - centre) + (i < centre ? 0.5 : 0), m] as const)
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1])
      .slice(0, Number.isFinite(capacity) ? capacity : months.length)
    let next = 0
    const worker = async () => {
      while (next < order.length && token === prefetchToken && get().analysisId === id) {
        const m = order[next++]
        if (cache.has(m)) continue
        try {
          await getSnapshot(id, m)
          set({ snapshotsLoaded: cache.size })
        } catch {
          /* individual month failures are retried on demand */
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))
  }

  function refreshLag() {
    const { mode, meta, analysisId, monthIndex, heatMetric } = get()
    if (mode !== 'heatmap' || !meta || !analysisId) return
    const lagIdx = monthIndex - heatWindow(heatMetric)
    if (lagIdx < 0) {
      set({ lagSnapshot: null })
      return
    }
    const month = meta.months[lagIdx]
    const hit = cachedSnapshot(month)
    if (hit) {
      set({ lagSnapshot: hit })
      return
    }
    getSnapshot(analysisId, month)
      .then((s) => {
        const st = get()
        if (st.mode === 'heatmap' && st.meta?.months[st.monthIndex - heatWindow(st.heatMetric)] === month) set({ lagSnapshot: s })
      })
      .catch(() => undefined)
  }

  return {
    analysisId: null,
    meta: null,
    layout: null,
    monthStats: [],
    loading: false,
    error: null,
    monthIndex: 0,
    snapshot: null,
    snapshotsLoaded: 0,
    heightMode: 'churn',
    colorMode: 'risk',
    mode: 'explore',
    playing: false,
    speed: 4,
    loop: false,
    heatMetric: 'churn',
    lagSnapshot: null,
    hovered: null,
    selected: null,
    hoveredDistrict: null,
    selectedDistrict: null,
    flyTarget: null,
    flyNonce: 0,
    resetNonce: 0,
    waveNonce: 0,
    fileDetail: null,
    fileLoading: false,
    pathFilter: '',
    hideTests: false,
    pvrCutoff: null,
    pvrK: 20,
    prediction: null,
    predictionLoading: false,
    revealed: false,
    showHotspotTopK: false,

    async load(id) {
      if (get().analysisId === id && get().meta) return
      prefetchToken++
      cache.clear()
      inflight.clear()
      set({
        analysisId: id, loading: true, error: null, meta: null, layout: null, snapshot: null, selected: null,
        hovered: null, mode: 'explore', prediction: null, revealed: false, playing: false, fileDetail: null,
        selectedDistrict: null, hoveredDistrict: null, lagSnapshot: null, pathFilter: '', hideTests: false,
        snapshotsLoaded: 0, flyTarget: null,
      })
      try {
        const [meta, layout, monthStats] = await Promise.all([api.meta(id), api.layout(id), api.snapshotIndex(id)])
        const bytesPerMonth = Math.max(1, layout.files.id.length) * SNAPSHOT_COLUMNS.length * 4
        capacity = Math.max(24, Math.floor(MEMORY_BUDGET_BYTES / bytesPerMonth))
        const last = meta.months.length - 1
        const snapshot = await getSnapshot(id, meta.months[last])
        if (get().analysisId !== id) return
        set({ meta, layout, monthStats, monthIndex: last, snapshot, loading: false, snapshotsLoaded: cache.size, pvrK: meta.topK })
        void prefetchAround(id, meta.months, last)
      } catch (e) {
        set({ loading: false, error: e instanceof Error ? e.message : String(e) })
      }
    },

    reset() {
      prefetchToken++
      cache.clear()
      inflight.clear()
      set({ analysisId: null, meta: null, layout: null, snapshot: null, monthStats: [], error: null, playing: false })
    },

    setMonthIndex(i) {
      const { meta, analysisId } = get()
      if (!meta || !analysisId) return
      const idx = Math.max(0, Math.min(meta.months.length - 1, Math.round(i)))
      if (idx === get().monthIndex && get().snapshot?.month === meta.months[idx]) return
      set({ monthIndex: idx })
      const month = meta.months[idx]
      // with a bounded cache, re-centre prefetching after big jumps
      if (Number.isFinite(capacity) && Math.abs(idx - prefetchCentre) > capacity / 3) void prefetchAround(analysisId, meta.months, idx)
      const hit = cachedSnapshot(month)
      if (hit) {
        set({ snapshot: hit })
        refreshLag()
        return
      }
      getSnapshot(analysisId, month)
        .then((s) => {
          if (get().meta?.months[get().monthIndex] === month) {
            set({ snapshot: s })
            refreshLag()
          }
        })
        .catch((e) => set({ error: String(e) }))
    },

    setHeightMode: (heightMode) => set({ heightMode, waveNonce: get().waveNonce + 1 }),
    setColorMode: (colorMode) => set({ colorMode, waveNonce: get().waveNonce + 1 }),
    setPlaying: (playing) => set({ playing }),
    togglePlay() {
      const s = get()
      if (!s.meta || s.mode === 'pvr') return
      if (!s.playing && s.monthIndex >= s.meta.months.length - 1) s.setMonthIndex(0)
      set({ playing: !s.playing })
    },
    setSpeed: (speed) => set({ speed }),
    setLoop: (loop) => set({ loop }),
    setHovered: (hovered) => {
      if (hovered !== get().hovered) set({ hovered })
    },

    select(i, fly = false) {
      const { layout, analysisId } = get()
      set({ selected: i, fileDetail: null, ...(i != null ? { selectedDistrict: null } : {}) })
      if (i == null || !layout || !analysisId) return
      if (fly) set({ flyNonce: get().flyNonce + 1, flyTarget: null })
      set({ fileLoading: true })
      api
        .file(analysisId, layout.files.id[i])
        .then((d) => {
          if (get().selected === i) set({ fileDetail: d, fileLoading: false })
        })
        .catch(() => set({ fileLoading: false }))
    },

    setHoveredDistrict: (i) => {
      if (i !== get().hoveredDistrict) set({ hoveredDistrict: i })
    },

    selectDistrict(i, fly = true) {
      const { layout } = get()
      set({ selectedDistrict: i, selected: i != null ? null : get().selected, waveNonce: get().waveNonce + 1 })
      if (i == null || !layout || !fly) return
      const d = layout.districts[i]
      get().flyTo({ x: d.x + d.w / 2, y: 0, z: d.y + d.h / 2, distance: Math.max(d.w, d.h) * 1.35 + layout.size * 0.03 })
    },

    flyTo: (t) => set({ flyTarget: t, flyNonce: get().flyNonce + 1 }),
    flyToSelected: () => set({ flyTarget: null, flyNonce: get().flyNonce + 1 }),
    resetView: () => set({ resetNonce: get().resetNonce + 1, flyTarget: null }),

    setPathFilter: (pathFilter) => set({ pathFilter }),
    setHideTests: (hideTests) => set({ hideTests, waveNonce: get().waveNonce + 1 }),

    setMode(mode) {
      const s = get()
      if (!s.meta || mode === s.mode) return
      if (mode === 'pvr') {
        const labelled = s.meta.cutoffs.filter((c) => c.hasLabels && c.trained)
        const pick = labelled.filter((c) => c.isEvalCutoff).at(-1) ?? labelled.at(-1)
        if (!pick) return
        set({ mode, playing: false, revealed: false, waveNonce: s.waveNonce + 1, lagSnapshot: null })
        void get().setPvrCutoff(pick.cutoff)
        return
      }
      set({ mode, prediction: null, revealed: false, pvrCutoff: null, waveNonce: s.waveNonce + 1, lagSnapshot: null })
      refreshLag()
    },

    setHeatMetric(heatMetric) {
      set({ heatMetric, waveNonce: get().waveNonce + 1 })
      refreshLag()
    },

    async setPvrCutoff(cutoff) {
      const { analysisId, meta } = get()
      if (!analysisId || !meta) return
      set({ pvrCutoff: cutoff, predictionLoading: true, revealed: false })
      get().setMonthIndex(meta.months.indexOf(cutoff))
      try {
        const prediction = await api.prediction(analysisId, cutoff)
        if (get().pvrCutoff === cutoff) set({ prediction, predictionLoading: false, waveNonce: get().waveNonce + 1 })
      } catch (e) {
        set({ predictionLoading: false, error: String(e) })
      }
    },

    stepPvrCutoff(delta) {
      const { meta, pvrCutoff } = get()
      if (!meta) return
      const list = meta.cutoffs.filter((c) => c.hasLabels && c.trained).map((c) => c.cutoff)
      const i = pvrCutoff ? list.indexOf(pvrCutoff) : -1
      const next = list[Math.max(0, Math.min(list.length - 1, i + delta))]
      if (next && next !== pvrCutoff) void get().setPvrCutoff(next)
    },

    setPvrK: (pvrK) => set({ pvrK }),
    setRevealed: (revealed) => set({ revealed }),
    setShowHotspotTopK: (showHotspotTopK) => set({ showHotspotTopK }),
  }
})
