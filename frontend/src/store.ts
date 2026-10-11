import { create } from 'zustand'
import { api, type FileDetail, type Layout, type Meta, type MonthStats, type Prediction, type Snapshot } from './api'
import type { ColorMode, HeightMode } from './data/transforms'

export type Mode = 'explore' | 'pvr'

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

  hovered: number | null
  selected: number | null
  flyNonce: number
  resetNonce: number
  fileDetail: FileDetail | null
  fileLoading: boolean

  pvrCutoff: string | null
  pvrK: number
  prediction: Prediction | null
  predictionLoading: boolean
  revealed: boolean

  load: (id: string) => Promise<void>
  reset: () => void
  setMonthIndex: (i: number) => void
  setHeightMode: (m: HeightMode) => void
  setColorMode: (m: ColorMode) => void
  setPlaying: (p: boolean) => void
  setSpeed: (s: number) => void
  setHovered: (i: number | null) => void
  select: (i: number | null, fly?: boolean) => void
  resetView: () => void
  enterPvr: () => void
  exitPvr: () => void
  setPvrCutoff: (c: string) => Promise<void>
  setPvrK: (k: number) => void
  setRevealed: (r: boolean) => void
}

// Snapshot cache lives outside React state: it can hold hundreds of large arrays.
const cache = new Map<string, Snapshot>()
const inflight = new Map<string, Promise<Snapshot>>()
let prefetchToken = 0

export function cachedSnapshot(month: string): Snapshot | undefined {
  return cache.get(month)
}

function fetchSnapshot(id: string, month: string): Promise<Snapshot> {
  const hit = cache.get(month)
  if (hit) return Promise.resolve(hit)
  let p = inflight.get(month)
  if (!p) {
    p = api.snapshot(id, month).then((s) => {
      cache.set(month, s)
      inflight.delete(month)
      return s
    })
    p.catch(() => inflight.delete(month))
    inflight.set(month, p)
  }
  return p
}

export const useCity = create<CityState>((set, get) => {
  async function prefetchAll(id: string, months: string[], startAt: number) {
    const token = ++prefetchToken
    // nearest months first, so scrubbing around the start is instant
    const order = months.map((m, i) => [Math.abs(i - startAt), m] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1])
    let next = 0
    const worker = async () => {
      while (next < order.length && token === prefetchToken && get().analysisId === id) {
        const m = order[next++]
        try {
          await fetchSnapshot(id, m)
          set({ snapshotsLoaded: cache.size })
        } catch {
          /* individual month failures are retried on demand */
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))
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
    hovered: null,
    selected: null,
    flyNonce: 0,
    resetNonce: 0,
    fileDetail: null,
    fileLoading: false,
    pvrCutoff: null,
    pvrK: 20,
    prediction: null,
    predictionLoading: false,
    revealed: false,

    async load(id) {
      if (get().analysisId === id && get().meta) return
      cache.clear()
      inflight.clear()
      set({
        analysisId: id, loading: true, error: null, meta: null, layout: null, snapshot: null, selected: null,
        hovered: null, mode: 'explore', prediction: null, revealed: false, playing: false, fileDetail: null,
      })
      try {
        const [meta, layout, monthStats] = await Promise.all([api.meta(id), api.layout(id), api.snapshotIndex(id)])
        const last = meta.months.length - 1
        const snapshot = await fetchSnapshot(id, meta.months[last])
        if (get().analysisId !== id) return
        set({ meta, layout, monthStats, monthIndex: last, snapshot, loading: false, snapshotsLoaded: cache.size, pvrK: meta.topK })
        void prefetchAll(id, meta.months, last)
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
      const idx = Math.max(0, Math.min(meta.months.length - 1, i))
      set({ monthIndex: idx })
      const month = meta.months[idx]
      const hit = cache.get(month)
      if (hit) {
        set({ snapshot: hit })
        return
      }
      fetchSnapshot(analysisId, month)
        .then((s) => {
          if (get().meta?.months[get().monthIndex] === month) set({ snapshot: s })
        })
        .catch((e) => set({ error: String(e) }))
    },

    setHeightMode: (heightMode) => set({ heightMode }),
    setColorMode: (colorMode) => set({ colorMode }),
    setPlaying: (playing) => set({ playing }),
    setSpeed: (speed) => set({ speed }),
    setHovered: (hovered) => set({ hovered }),

    select(i, fly = false) {
      const { layout, analysisId } = get()
      set({ selected: i, flyNonce: fly ? get().flyNonce + 1 : get().flyNonce, fileDetail: null })
      if (i == null || !layout || !analysisId) return
      set({ fileLoading: true })
      api
        .file(analysisId, layout.files.id[i])
        .then((d) => {
          if (get().selected === i) set({ fileDetail: d, fileLoading: false })
        })
        .catch(() => set({ fileLoading: false }))
    },

    resetView: () => set({ resetNonce: get().resetNonce + 1 }),

    enterPvr() {
      const meta = get().meta
      if (!meta) return
      const labelled = meta.cutoffs.filter((c) => c.hasLabels && c.trained)
      const pick = labelled.filter((c) => c.isEvalCutoff).at(-1) ?? labelled.at(-1)
      set({ mode: 'pvr', playing: false, revealed: false })
      if (pick) void get().setPvrCutoff(pick.cutoff)
    },

    exitPvr() {
      set({ mode: 'explore', prediction: null, revealed: false, pvrCutoff: null })
    },

    async setPvrCutoff(cutoff) {
      const { analysisId, meta } = get()
      if (!analysisId || !meta) return
      set({ pvrCutoff: cutoff, predictionLoading: true, revealed: false })
      get().setMonthIndex(meta.months.indexOf(cutoff))
      try {
        const prediction = await api.prediction(analysisId, cutoff)
        if (get().pvrCutoff === cutoff) set({ prediction, predictionLoading: false })
      } catch (e) {
        set({ predictionLoading: false, error: String(e) })
      }
    },

    setPvrK: (pvrK) => set({ pvrK }),
    setRevealed: (revealed) => set({ revealed }),
  }
})
