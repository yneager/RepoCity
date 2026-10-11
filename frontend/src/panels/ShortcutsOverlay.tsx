import { useEffect } from 'react'
import { create } from 'zustand'
import { downloadScreenshot } from '../city/capture'
import { COLOR_MODES, HEIGHT_MODES } from '../data/transforms'
import { useSettings } from '../motion'
import { useCity } from '../store'
import { Icon } from '../ui'
import { searchInputRef } from './TopBar'

const useOverlay = create<{ open: boolean }>(() => ({ open: false }))
export const openShortcuts = () => useOverlay.setState({ open: true })

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause the history'],
  ['← / →', 'Previous / next month'],
  ['Shift + ← / →', 'One year back / forward'],
  ['Home / End', 'First / last month'],
  ['E · H · P', 'Explore · Heatmap · Prediction vs Reality'],
  ['1 – 3', 'Height: churn, complexity, commits'],
  ['4 – 7', 'Colour: risk, authors, age, bug history'],
  ['[ / ]', 'Previous / next cutoff (Prediction vs Reality)'],
  ['V', 'Reveal reality (Prediction vs Reality)'],
  ['/', 'Search a file'],
  ['R', 'Reset the camera'],
  ['O', 'Toggle slow orbit'],
  ['L', 'Toggle district labels'],
  ['S', 'Save a screenshot'],
  ['Esc', 'Close panels and selections'],
  ['?', 'This help'],
]

export function screenshotName(): string {
  const { meta, monthIndex } = useCity.getState()
  const name = (meta?.name ?? 'city').replace(/[^a-z0-9]+/gi, '-')
  return `repocity-${name}-${meta?.months[monthIndex] ?? ''}.png`
}

/** Global keyboard shortcuts for the city view (ignored while typing in a field). */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range')) return
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const st = useCity.getState()
      const settings = useSettings.getState()
      const months = st.meta?.months.length ?? 0
      const k = e.key
      let handled = true
      if (k === ' ') st.togglePlay()
      else if (k === 'ArrowRight' && st.mode !== 'pvr') st.setMonthIndex(st.monthIndex + (e.shiftKey ? 12 : 1))
      else if (k === 'ArrowLeft' && st.mode !== 'pvr') st.setMonthIndex(st.monthIndex - (e.shiftKey ? 12 : 1))
      else if (k === 'Home' && st.mode !== 'pvr') st.setMonthIndex(0)
      else if (k === 'End' && st.mode !== 'pvr') st.setMonthIndex(months - 1)
      else if (k === 'e' || k === 'E') st.setMode('explore')
      else if (k === 'h' || k === 'H') st.setMode('heatmap')
      else if (k === 'p' || k === 'P') st.setMode('pvr')
      else if (k === 'r' || k === 'R') st.resetView()
      else if (k === 'o' || k === 'O') settings.set({ autoOrbit: !settings.autoOrbit })
      else if (k === 'l' || k === 'L') settings.set({ showLabels: !settings.showLabels })
      else if (k === 's' || k === 'S') downloadScreenshot(screenshotName())
      else if (k === '[' && st.mode === 'pvr') st.stepPvrCutoff(-1)
      else if (k === ']' && st.mode === 'pvr') st.stepPvrCutoff(1)
      else if ((k === 'v' || k === 'V') && st.mode === 'pvr' && st.prediction) st.setRevealed(!st.revealed)
      else if (k === '/') searchInputRef.current?.focus()
      else if (k === '?') useOverlay.setState({ open: !useOverlay.getState().open })
      else if (k === 'Escape') {
        if (useOverlay.getState().open) useOverlay.setState({ open: false })
        else if (st.selected != null) st.select(null)
        else if (st.selectedDistrict != null) st.selectDistrict(null)
        else handled = false
      } else if (HEIGHT_MODES.some((m) => m.key === k)) st.setHeightMode(HEIGHT_MODES.find((m) => m.key === k)!.id)
      else if (COLOR_MODES.some((m) => m.key === k)) st.setColorMode(COLOR_MODES.find((m) => m.key === k)!.id)
      else handled = false
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function ShortcutsOverlay() {
  const open = useOverlay((s) => s.open)
  if (!open) return null
  return (
    <div
      className="backdrop fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 backdrop-blur-sm"
      onClick={() => useOverlay.setState({ open: false })}
      data-testid="shortcuts-overlay"
    >
      <div className="panel w-[560px] p-6 animate-[pop_var(--dur)_var(--ease-out)_both]" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[16px] font-semibold text-white">
            <Icon.Keyboard size={18} /> Keyboard shortcuts
          </div>
          <button onClick={() => useOverlay.setState({ open: false })} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close">
            <Icon.Close size={16} />
          </button>
        </div>
        <div className="stagger mt-4 grid grid-cols-1 gap-y-2">
          {SHORTCUTS.map(([keys, what], i) => (
            <div key={keys} className="flex items-center justify-between gap-4 text-[13px]" style={{ ['--i' as string]: i }}>
              <span className="text-slate-300">{what}</span>
              <span className="flex gap-1">
                {keys.split(' ').map((part, j, all) =>
                  all.length > 1 && ['/', '·', '+', '–'].includes(part) ? (
                    <span key={j} className="px-0.5 text-slate-500">{part}</span>
                  ) : (
                    <span key={j} className="kbd">{part}</span>
                  ),
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
