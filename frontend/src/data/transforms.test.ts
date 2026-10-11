import { describe, expect, it } from 'vitest'
import type { Layout, Meta, Prediction, Snapshot } from '../api'
import { fileDepths } from '../city/geometry'
import { parseHash } from '../router'
import { cityAnim, pickBuilding, resetAnim } from '../city/anim'
import { smoothDamp } from '../motion'
import { parseQuery } from '../urlState'
import {
  addMonths,
  curveAt,
  districtStats,
  effortCurve,
  filterMasks,
  heatNormalised,
  heatValues,
  isTestPath,
  leaderboard,
  optimalOrder,
  approach,
  buildingHeight,
  encodeSnapshot,
  footprint,
  formatMonth,
  isValidRepoUrl,
  NO_DATA,
  rampColor,
  RISK_STOPS,
  riskFromPrediction,
  scoreCard,
  searchPaths,
} from './transforms'

const layout: Layout = {
  size: 1000,
  files: {
    id: [10, 11, 12],
    path: ['src/app.py', 'src/util/helpers.py', 'tests/test_app.py'],
    x: [100, 300, 700],
    z: [100, 300, 700],
    w: [100, 50, 80],
    d: [100, 50, 80],
    maxLoc: [400, 100, 200],
  },
  districts: [
    { path: 'src', label: 'src', x: 0, y: 0, w: 500, h: 500, depth: 1 },
    { path: 'src/util', label: 'util', x: 250, y: 250, w: 100, h: 100, depth: 2 },
    { path: 'tests', label: 'tests', x: 600, y: 600, w: 300, h: 300, depth: 1 },
  ],
}

const meta = {
  maxima: { churn: 1000, commits: 50, ccn: 80, authors: 6, age: 120, fixes: 9, loc: 400 },
} as unknown as Meta

const snap: Snapshot = {
  month: '2020-05', riskCutoff: '2020-04',
  loc: [400, 0, 50], ccn: [80, 0, 4], churn: [1000, 0, 10], commits: [50, 0, 2], authors: [6, 0, 1],
  age: [120, 0, 3], fixes: [9, 0, 0], bornTotal: [0, 0, 0], born: [0, 0, 0], risk: [1, -1, 0],
}

describe('encoding', () => {
  it('hides files that do not exist and scales the rest', () => {
    const e = encodeSnapshot(layout, meta, snap, { heightMode: 'churn', colorMode: 'risk' })
    expect(e.height[1]).toBe(0)
    expect(e.sx[1]).toBe(0)
    expect(e.height[0]).toBeCloseTo(buildingHeight(1000, 1000, 1000))
    expect(e.height[0]).toBeGreaterThan(e.height[2])
    // highest risk is red, lowest green
    expect(Array.from(e.color.slice(0, 3))).toEqual(RISK_STOPS[4].map((v) => Math.fround(v)))
    expect(Array.from(e.color.slice(6, 9))).toEqual(RISK_STOPS[0].map((v) => Math.fround(v)))
  })

  it('uses grey for files without a prediction', () => {
    const e = encodeSnapshot(layout, meta, { ...snap, loc: [400, 10, 50] }, { heightMode: 'commits', colorMode: 'risk' })
    expect(Array.from(e.color.slice(3, 6))).toEqual(NO_DATA.map((v) => Math.fround(v)))
  })

  it('footprint area is proportional to LOC inside the reserved lot', () => {
    const [w1, d1] = footprint(layout, 0, 400)
    const [w2, d2] = footprint(layout, 0, 100)
    expect((w2 * d2) / (w1 * d1)).toBeCloseTo(0.25)
    expect(footprint(layout, 0, 0)).toEqual([0, 0])
    expect(w1).toBeLessThan(layout.files.w[0]) // a street gap remains
  })

  it('ramps interpolate and clamp', () => {
    expect(rampColor(RISK_STOPS, -1)).toEqual(RISK_STOPS[0])
    rampColor(RISK_STOPS, 2).forEach((v, k) => expect(v).toBeCloseTo(RISK_STOPS[4][k], 9))
    const mid = rampColor([[0, 0, 0], [1, 1, 1]], 0.25)
    expect(mid[0]).toBeCloseTo(0.25)
  })
})

describe('prediction vs reality', () => {
  const p = {
    files: [0, 2, 1],
    riskPct: [0.9, 0.1, 0.5],
    actual: [1, 0, 1],
    rankModel: [0, 2, 1],
    rankHotspot: [1, 2, 0],
  } as unknown as Prediction

  it('maps prediction rows onto buildings', () => {
    expect(Array.from(riskFromPrediction(p, 3))).toEqual([0.9, 0.5, 0.1].map(Math.fround))
  })

  it('computes hits@k from the exported rank orders', () => {
    const c = scoreCard(p, 2)
    expect(c.hits).toBe(2) // rows 0 and 2 (buildings 0 and 1) were both fixed
    expect(c.precision).toBe(1)
    expect(c.hotspotHits).toBe(1) // hotspot's top-2 rows are 1 and 2; only row 2 was fixed
    expect(c.topK).toEqual([0, 1])
    expect(c.positives).toBe(2)
    expect(scoreCard(p, 10).k).toBe(3) // k is capped at the number of files
  })
})

describe('helpers', () => {
  it('searches file names before directories', () => {
    const paths = ['lib/app_test.py', 'app.py', 'src/application.py', 'docs/conf.py']
    expect(searchPaths(paths, 'app').map((i) => paths[i])).toEqual(['app.py', 'lib/app_test.py', 'src/application.py'])
    expect(searchPaths(paths, '')).toEqual([])
    expect(searchPaths(paths, 'app', 10, (i) => i !== 1).map((i) => paths[i])).toEqual(['lib/app_test.py', 'src/application.py'])
  })

  it('formats and adds months', () => {
    expect(formatMonth('2024-03')).toBe('Mar 2024')
    expect(addMonths('2024-11', 3)).toBe('2025-02')
    expect(addMonths('2024-01', -1)).toBe('2023-12')
  })

  it('validates repository URLs like the backend', () => {
    expect(isValidRepoUrl('https://github.com/pallets/flask')).toBe(true)
    expect(isValidRepoUrl('https://gitlab.com/group/sub/repo.git')).toBe(true)
    expect(isValidRepoUrl('http://github.com/a/b')).toBe(false)
    expect(isValidRepoUrl('git@github.com:a/b.git')).toBe(false)
    expect(isValidRepoUrl('https://user:pw@github.com/a/b')).toBe(false)
  })

  it('animation smoothing converges and is frame-rate independent', () => {
    let a = 0
    for (let i = 0; i < 60; i++) a = approach(a, 10, 1 / 60)
    let b = 0
    for (let i = 0; i < 30; i++) b = approach(b, 10, 1 / 30)
    expect(a).toBeCloseTo(b, 5)
    expect(a).toBeGreaterThan(9.9)
  })

  it('finds the innermost district of each file', () => {
    expect(Array.from(fileDepths(layout))).toEqual([1, 2, 1])
  })

  it('parses hash routes', () => {
    expect(parseHash('#/city/pallets-flask-d086db85')).toEqual({ page: 'city', id: 'pallets-flask-d086db85' })
    expect(parseHash('#/analyze/x')).toEqual({ page: 'analyze', id: 'x' })
    expect(parseHash('')).toEqual({ page: 'home' })
  })
})

describe('heatmap', () => {
  it('measures activity in the trailing window and normalises it', () => {
    const lag = { ...snap, churn: [400, 0, 10] }
    const v = heatValues(snap, lag, 'churn')
    expect(Array.from(v)).toEqual([600, 0, 0])
    const n = heatNormalised(v, snap.loc)
    expect(n[0]).toBeCloseTo(1)
    expect(n[1]).toBe(-1) // file does not exist
    expect(n[2]).toBe(0)
  })

  it('flattens the city and colours by heat', () => {
    const heat = Float32Array.from([1, -1, 0])
    const flat = encodeSnapshot(layout, meta, snap, { heightMode: 'churn', colorMode: 'risk', heat })
    const tall = encodeSnapshot(layout, meta, snap, { heightMode: 'churn', colorMode: 'risk' })
    expect(flat.height[0]).toBeLessThan(tall.height[0] * 0.5)
    expect(flat.height[2]).toBeLessThan(flat.height[0])
  })
})

describe('filters', () => {
  it('recognises test files across languages', () => {
    for (const p of ['tests/test_app.py', 'src/test/java/FooTest.java', 'lib/a.spec.ts', 'pkg/x_test.go', '__tests__/b.js', 'test_cli.py'])
      expect(isTestPath(p)).toBe(true)
    for (const p of ['src/app.py', 'lib/contest.js', 'src/main/java/Testing2.java', 'attest/a.py']) expect(isTestPath(p)).toBe(false)
  })

  it('hides tests, dims non-matching paths and everything outside a focused district', () => {
    const m = filterMasks(layout.files.path, { hideTests: true, pathFilter: 'util', district: null })
    expect(Array.from(m.hidden)).toEqual([0, 0, 1])
    expect(Array.from(m.dimmed)).toEqual([1, 0, 1])
    const d = filterMasks(layout.files.path, { hideTests: false, pathFilter: '', district: 'src/util' })
    expect(Array.from(d.dimmed)).toEqual([1, 0, 1])
    expect(filterMasks(layout.files.path, { hideTests: false, pathFilter: '', district: null }).active).toBe(false)
    const e = encodeSnapshot(layout, meta, snap, { heightMode: 'churn', colorMode: 'risk', masks: m })
    expect(e.height[2]).toBe(0) // hidden test file
  })
})

describe('effort curves', () => {
  const loc = [10, 10, 10, 70]
  const actual = [1, 0, 1, 0]
  it('optimal order reads fixed small files first', () => {
    expect(optimalOrder(loc, actual)).toEqual([0, 2, 1, 3])
  })
  it('curve starts at 0, ends at 1 and gives recall at 20% LOC', () => {
    const c = effortCurve([0, 2, 1, 3], loc, actual)
    expect(c[0]).toEqual([0, 0])
    expect(c.at(-1)).toEqual([1, 1])
    expect(curveAt(c, 0.2)).toBeCloseTo(1)
    const worst = effortCurve([3, 1, 0, 2], loc, actual)
    expect(curveAt(worst, 0.2)).toBe(0)
  })
})

describe('districts and rankings', () => {
  it('summarises a district', () => {
    const s = districtStats(layout, { ...snap, loc: [400, 30, 50], risk: [0.9, 0.4, 0.1], commits: [50, 5, 2] }, 'src')
    expect(s.files).toBe(2)
    expect(s.loc).toBe(430)
    expect(s.members).toEqual([0, 1])
    expect(s.avgRisk).toBeCloseTo(0.65)
  })
  it('ranks existing files', () => {
    expect(leaderboard(snap, 'risk', 5)).toEqual([0, 2])
    expect(leaderboard(snap, 'churn', 1)).toEqual([0])
    expect(leaderboard(snap, 'fixes', 5)).toEqual([0])
    expect(leaderboard(snap, 'risk', 5, Uint8Array.from([1, 0, 0]))).toEqual([2])
  })
})

describe('motion', () => {
  it('smoothDamp converges without overshoot, independent of frame rate', () => {
    const run = (fps: number) => {
      const v = new Float32Array(1)
      let x = 0
      let max = 0
      for (let i = 0; i < fps * 4; i++) {
        x = smoothDamp(x, 10, v, 0, 0.8, 1 / fps)
        max = Math.max(max, x)
      }
      return { x, max }
    }
    const a = run(60)
    const b = run(30)
    expect(a.x).toBeCloseTo(10, 1)
    expect(a.max).toBeLessThanOrEqual(10)
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.05)
  })
})

describe('picking', () => {
  it('finds the nearest building along a ray', () => {
    resetAnim(Float32Array.from([0, 10]), Float32Array.from([0, 0]), Float32Array.from([0, 0]), 100)
    cityAnim.h.set([5, 20])
    cityAnim.sx.set([2, 2])
    cityAnim.sz.set([2, 2])
    // straight down onto building 1
    expect(pickBuilding(10, 100, 0, 0, -1, 0)?.index).toBe(1)
    // horizontal ray at height 3 from the left hits building 0 first
    expect(pickBuilding(-50, 3, 0, 1, 0, 0)?.index).toBe(0)
    // above building 0 but below building 1's roof: hits 1
    expect(pickBuilding(-50, 10, 0, 1, 0, 0)?.index).toBe(1)
    expect(pickBuilding(-50, 30, 0, 1, 0, 0)).toBeNull()
  })
})

describe('url state', () => {
  it('reads the query part of the hash', () => {
    const q = parseQuery('#/city/x?m=2020-05&mode=heatmap&f=12')
    expect(q.get('m')).toBe('2020-05')
    expect(q.get('mode')).toBe('heatmap')
    expect(q.get('f')).toBe('12')
    expect(parseQuery('#/city/x').toString()).toBe('')
    expect(parseHash('#/city/abc?m=2020-01')).toEqual({ page: 'city', id: 'abc' })
  })
})
