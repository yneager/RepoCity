// Typed client for the RepoCity API (see backend/repocity/api/app.py).

export interface CutoffInfo {
  cutoff: string
  hasLabels: boolean
  isEvalCutoff: boolean
  trained: boolean
}

export interface Meta {
  id: string
  name: string
  url: string | null
  head: string
  webUrl: string | null
  months: string[]
  firstCommit: number
  lastCommit: number
  nCommits: number
  nBugfixes: number
  nFiles: number
  nBuildingsLast: number
  locLast: number
  cutoffs: CutoffInfo[]
  evalCutoffs: string[]
  horizonMonths: number
  topK: number
  maxima: Record<'churn' | 'commits' | 'ccn' | 'authors' | 'age' | 'fixes' | 'loc', number>
  featureLabels: Record<string, string>
  featureGroups: Record<string, string[]>
  methodLabels: Record<string, string>
  metricLabels: Record<string, string>
  warnings?: string[]
  language?: string
  description?: string
}

export interface District {
  path: string
  label: string
  x: number
  y: number
  w: number
  h: number
  depth: number
}

export interface Layout {
  size: number
  files: { id: number[]; path: string[]; x: number[]; z: number[]; w: number[]; d: number[]; maxLoc: number[] }
  districts: District[]
}

export interface MonthStats {
  month: string
  files: number
  loc: number
  commits: number
  fixes: number
  /** bug-fix commits in this month (absent in old bundles) */
  fixesMonth?: number
  commitsMonth?: number
  /** SZZ bug-introducing commits dated in this month */
  born?: number
}

/** Numeric per-building column; typed arrays at runtime (see store.ts), plain arrays in tests. */
export type Column = ArrayLike<number>

export interface Snapshot {
  month: string
  riskCutoff: string | null
  loc: Column
  ccn: Column
  churn: Column
  commits: Column
  authors: Column
  age: Column
  fixes: Column
  bornTotal: Column
  born: Column
  risk: Column
}

export const SNAPSHOT_COLUMNS = ['loc', 'ccn', 'churn', 'commits', 'authors', 'age', 'fixes', 'bornTotal', 'born', 'risk'] as const

export type MetricSet = Record<
  'roc_auc' | 'pr_auc' | 'recall_20loc' | 'popt' | 'p_at_10' | 'p_at_20' | 'recall_20loc_ea' | 'popt_ea',
  number | null
>

export interface Prediction {
  cutoff: string
  horizonEnd: string
  hasLabels: boolean
  model: string
  trained: boolean
  trainMonths: string[]
  nTrain: number
  nTrainPos: number
  isEvalCutoff: boolean
  files: number[]
  risk: (number | null)[]
  riskPct: (number | null)[]
  hotspot: (number | null)[]
  actual: number[] | null
  shap: [string, number | null, number | null][][] | null
  rankModel: number[]
  rankHotspot: number[]
  rankModelEa?: number[]
  rankHotspotEa?: number[]
  metrics: Record<string, MetricSet>
  fixcacheHitRate: number | null
}

export interface CommitInfo {
  hash: string
  time: number
  initials: string
  fix: boolean
  subject: string
  merge: boolean
  added?: number
  deleted?: number
}

export interface FileDetail {
  fileId: number
  path: string
  created: string | null
  webUrl: string | null
  nChanges: number
  sparkline: { months: string[]; commits: number[] }
  authors: { id: string; initials: string; commits: number; share: number }[]
  nAuthors: number
  fixes: CommitInfo[]
  nFixes: number
  recent: CommitInfo[]
  pathHistory: { path: string; time: number }[]
  bugsBorn: { introHash: string; introTime: number; fix: CommitInfo }[]
  nBugsBorn: number
}

export interface DemoRepo {
  id: string
  name: string
  url: string | null
  nCommits: number
  nFiles: number
  firstMonth: string
  lastMonth: string
  language?: string
  description?: string
}

export interface JobSummary {
  id: string
  url: string | null
  name: string
  status: 'queued' | 'running' | 'done' | 'error'
  error: string | null
  warnings: string[]
  progress: number
  step?: string
  demo: boolean
  created?: number
  queuePosition?: number
  nCommits?: number
  nFiles?: number
  firstMonth?: string
  lastMonth?: string
  meta?: Meta
}

export interface ProgressEvent {
  seq: number
  kind: 'progress' | 'warning' | 'done' | 'error'
  step: string
  stepProgress: number
  progress: number
  message: string
  time: number
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal })
  if (!res.ok) throw new ApiError(res.status, await errorText(res))
  return res.json() as Promise<T>
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body.detail === 'string') return body.detail
    if (Array.isArray(body.detail)) return body.detail.map((d: { msg: string }) => d.msg).join('; ')
  } catch {
    /* not JSON */
  }
  return `${res.status} ${res.statusText}`
}

const base = (id: string) => `/api/analyses/${encodeURIComponent(id)}`

export const api = {
  health: () => get<{ status: string }>('/api/health'),
  demos: () => get<DemoRepo[]>('/api/demo'),
  status: (id: string) => get<JobSummary>(base(id)),
  list: () => get<JobSummary[]>('/api/analyses'),
  async cancel(id: string): Promise<JobSummary> {
    const res = await fetch(`${base(id)}/cancel`, { method: 'POST' })
    if (!res.ok) throw new ApiError(res.status, await errorText(res))
    return res.json()
  },
  meta: (id: string) => get<Meta>(`${base(id)}/meta`),
  layout: (id: string) => get<Layout>(`${base(id)}/layout`),
  snapshotIndex: (id: string) => get<MonthStats[]>(`${base(id)}/snapshots`),
  snapshot: (id: string, month: string, signal?: AbortSignal) => get<Snapshot>(`${base(id)}/snapshots/${month}`, signal),
  prediction: (id: string, cutoff: string) => get<Prediction>(`${base(id)}/predictions?cutoff=${cutoff}`),
  file: (id: string, fileId: number) => get<FileDetail>(`${base(id)}/files/${fileId}`),
  async start(url: string): Promise<JobSummary> {
    const res = await fetch('/api/analyses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    if (!res.ok) throw new ApiError(res.status, await errorText(res))
    return res.json()
  },
  events(id: string, onEvent: (e: ProgressEvent) => void, onFail: () => void): () => void {
    const es = new EventSource(`${base(id)}/events`)
    const handler = (msg: MessageEvent) => {
      const ev = JSON.parse(msg.data) as ProgressEvent
      onEvent(ev)
      if (ev.kind === 'done' || ev.kind === 'error') es.close()
    }
    for (const kind of ['progress', 'warning', 'done', 'error']) es.addEventListener(kind, handler as EventListener)
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) onFail()
    }
    return () => es.close()
  },
}
