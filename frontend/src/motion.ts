// User settings (motion level, quality, overlays), persisted in localStorage when available.
import { create } from 'zustand'

export type MotionLevel = 'cinematic' | 'smooth' | 'reduced'
export type Quality = 'auto' | 'high' | 'low'

export interface MotionParams {
  /** SmoothDamp time (s) for building height / footprint */
  building: number
  /** exponential colour rate (1/s) */
  color: number
  /** camera-controls smoothTime (s) */
  camera: number
  /** max per-building delay (s) of the wave when encodings change */
  wave: number
  /** multiplier for UI (CSS) transition durations */
  ui: number
}

export const MOTION: Record<MotionLevel, MotionParams> = {
  cinematic: { building: 0.85, color: 1.6, camera: 1.0, wave: 1.3, ui: 1 },
  smooth: { building: 0.4, color: 3.5, camera: 0.5, wave: 0.6, ui: 0.6 },
  reduced: { building: 0.02, color: 60, camera: 0.05, wave: 0, ui: 0 },
}

interface Settings {
  motion: MotionLevel
  quality: Quality
  showLabels: boolean
  showSparks: boolean
  autoOrbit: boolean
  set: (patch: Partial<Omit<Settings, 'set'>>) => void
}

const KEY = 'repocity.settings.v1'

function initial(): Omit<Settings, 'set'> {
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const base: Omit<Settings, 'set'> = {
    motion: prefersReduced ? 'reduced' : 'cinematic',
    quality: 'auto',
    showLabels: true,
    showSparks: true,
    autoOrbit: false,
  }
  try {
    const q = new URLSearchParams(window.location.search).get('quality')
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const merged = { ...base, ...saved, autoOrbit: false }
    if (q === 'high' || q === 'low' || q === 'auto') merged.quality = q
    return merged
  } catch {
    return base
  }
}

export const useSettings = create<Settings>((set, get) => ({
  ...initial(),
  set(patch) {
    set(patch)
    try {
      const { motion, quality, showLabels, showSparks } = { ...get(), ...patch }
      localStorage.setItem(KEY, JSON.stringify({ motion, quality, showLabels, showSparks }))
    } catch {
      /* storage unavailable: settings last for this page view only */
    }
  },
}))

export const motionParams = (): MotionParams => MOTION[useSettings.getState().motion]

/** Unity-style critically damped spring: smooth ease-in/ease-out towards a moving target. */
export function smoothDamp(current: number, target: number, velocity: Float32Array, i: number, smoothTime: number, dt: number): number {
  const st = Math.max(0.0001, smoothTime)
  const omega = 2 / st
  const x = omega * dt
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = current - target
  const temp = (velocity[i] + omega * change) * dt
  velocity[i] = (velocity[i] - omega * temp) * exp
  let out = target + (change + temp) * exp
  // prevent overshoot
  if ((target - current > 0) === (out > target)) {
    out = target
    velocity[i] = 0
  }
  return out
}

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
export const easeInOutCubic = (t: number) => {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}
