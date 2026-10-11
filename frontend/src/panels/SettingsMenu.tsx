import { useEffect, useRef, useState } from 'react'
import { useSettings, type MotionLevel, type Quality } from '../motion'
import { Icon } from '../ui'

const MOTIONS: { id: MotionLevel; label: string; help: string }[] = [
  { id: 'cinematic', label: 'Cinematic', help: 'Slow, eased transitions everywhere' },
  { id: 'smooth', label: 'Smooth', help: 'Shorter transitions' },
  { id: 'reduced', label: 'Reduced', help: 'Almost no motion' },
]
const QUALITIES: { id: Quality; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'high', label: 'High' },
  { id: 'low', label: 'Low' },
]

/** Keeps the CSS motion scale in sync with the setting (used by every CSS transition). */
export function MotionSync() {
  const motion = useSettings((s) => s.motion)
  useEffect(() => {
    document.documentElement.style.setProperty('--motion', motion === 'cinematic' ? '1' : motion === 'smooth' ? '0.6' : '0')
  }, [motion])
  return null
}

export function SettingsMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const s = useSettings()
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`rounded-lg p-2 hover:bg-slate-800 hover:text-white ${open ? 'bg-slate-800 text-white' : 'text-slate-400'}`}
        aria-label="Settings"
        aria-expanded={open}
        data-testid="settings-button"
      >
        <Icon.Gear size={17} className={`transition-transform duration-700 ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="panel absolute right-0 top-11 z-40 w-[290px] p-4 animate-fade-in" data-testid="settings-menu">
          <div className="panel-title">Motion</div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {MOTIONS.map((m) => (
              <button
                key={m.id}
                onClick={() => s.set({ motion: m.id })}
                title={m.help}
                aria-pressed={s.motion === m.id}
                className={`rounded-lg border px-2 py-1.5 text-[12.5px] ${s.motion === m.id ? 'border-sky-400/50 bg-sky-400/10 text-white' : 'border-slate-700/60 text-slate-400 hover:text-slate-200'}`}
                data-testid={`motion-${m.id}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="panel-title mt-4">Render quality</div>
          <div className="seg mt-2 w-full">
            {QUALITIES.map((q) => (
              <button key={q.id} className="flex-1" aria-pressed={s.quality === q.id} onClick={() => s.set({ quality: q.id })}>
                {q.label}
              </button>
            ))}
          </div>
          <div className="mt-4 space-y-2.5">
            <Toggle label="District labels" checked={s.showLabels} onChange={(v) => s.set({ showLabels: v })} />
            <Toggle label="Bug-birth sparks during replay" checked={s.showSparks} onChange={(v) => s.set({ showSparks: v })} />
            <Toggle label="Slowly orbit the city" checked={s.autoOrbit} onChange={(v) => s.set({ autoOrbit: v })} testid="toggle-orbit" />
          </div>
        </div>
      )}
    </div>
  )
}

export function Toggle({ label, checked, onChange, testid }: { label: string; checked: boolean; onChange: (v: boolean) => void; testid?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[12.5px] text-slate-300">
      <span>{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full ${checked ? 'bg-sky-500' : 'bg-slate-700'}`}
        data-testid={testid}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] duration-500 ease-out ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  )
}
