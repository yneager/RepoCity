// Keeps the view in the URL (#/city/<id>?m=2020-05&mode=heatmap&f=<fileId>...) so a view can be
// shared or survives a reload. Applied once when the city has loaded, then written back on change.
import { useEffect, useRef } from 'react'
import { COLOR_MODES, HEAT_METRICS, HEIGHT_MODES } from './data/transforms'
import { useCity, type Mode } from './store'

export function parseQuery(hash: string): URLSearchParams {
  const q = hash.indexOf('?')
  return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '')
}

export function buildQuery(s: ReturnType<typeof useCity.getState>): string {
  const p = new URLSearchParams()
  if (!s.meta || !s.layout) return ''
  if (s.mode !== 'pvr') {
    const m = s.meta.months[s.monthIndex]
    if (m && s.monthIndex !== s.meta.months.length - 1) p.set('m', m)
  }
  if (s.mode !== 'explore') p.set('mode', s.mode)
  if (s.mode === 'pvr' && s.pvrCutoff) p.set('cut', s.pvrCutoff)
  if (s.mode === 'heatmap' && s.heatMetric !== 'churn') p.set('heat', s.heatMetric)
  if (s.heightMode !== 'churn') p.set('h', s.heightMode)
  if (s.colorMode !== 'risk') p.set('c', s.colorMode)
  if (s.selected != null) p.set('f', String(s.layout.files.id[s.selected]))
  else if (s.selectedDistrict != null) p.set('d', s.layout.districts[s.selectedDistrict].path)
  const out = p.toString()
  return out ? `?${out}` : ''
}

export function applyQuery(q: URLSearchParams): void {
  const s = useCity.getState()
  if (!s.meta || !s.layout) return
  const h = q.get('h')
  if (h && HEIGHT_MODES.some((m) => m.id === h)) s.setHeightMode(h as never)
  const c = q.get('c')
  if (c && COLOR_MODES.some((m) => m.id === c)) s.setColorMode(c as never)
  const heat = q.get('heat')
  if (heat && HEAT_METRICS.some((m) => m.id === heat)) useCity.setState({ heatMetric: heat as never })
  const mode = q.get('mode') as Mode | null
  const m = q.get('m')
  if (m) {
    const idx = s.meta.months.indexOf(m)
    if (idx >= 0) s.setMonthIndex(idx)
  }
  if (mode === 'heatmap') s.setMode('heatmap')
  if (mode === 'pvr') {
    s.setMode('pvr')
    const cut = q.get('cut')
    if (cut && s.meta.cutoffs.some((x) => x.cutoff === cut && x.hasLabels && x.trained)) void useCity.getState().setPvrCutoff(cut)
  }
  const f = q.get('f')
  if (f != null) {
    const i = s.layout.files.id.indexOf(Number(f))
    if (i >= 0) setTimeout(() => useCity.getState().select(i, true), 900) // after the intro fly-in
  } else {
    const d = q.get('d')
    const di = d ? s.layout.districts.findIndex((x) => x.path === d) : -1
    if (di >= 0) setTimeout(() => useCity.getState().selectDistrict(di), 900)
  }
}

export function useUrlState(id: string): void {
  const applied = useRef<string | null>(null)
  const ready = useCity((s) => !!(s.meta && s.layout && s.snapshot && !s.loading && s.analysisId === id))
  useEffect(() => {
    if (!ready || applied.current === id) return
    applied.current = id
    applyQuery(parseQuery(window.location.hash))
  }, [ready, id])
  useEffect(() => {
    if (!ready) return
    let timer = 0
    const unsub = useCity.subscribe((s) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (s.analysisId !== id) return
        const next = `#/city/${encodeURIComponent(id)}${buildQuery(useCity.getState())}`
        if (window.location.hash !== next) window.history.replaceState(null, '', next)
      }, 350)
    })
    return () => {
      unsub()
      window.clearTimeout(timer)
    }
  }, [ready, id])
}
