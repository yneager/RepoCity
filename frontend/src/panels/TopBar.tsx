import { useMemo, useRef, useState } from 'react'
import { searchPaths } from '../data/transforms'
import { navigate } from '../router'
import { useCity } from '../store'
import { Icon, Logo } from '../ui'

export function TopBar() {
  const meta = useCity((s) => s.meta)
  const mode = useCity((s) => s.mode)
  const enterPvr = useCity((s) => s.enterPvr)
  const exitPvr = useCity((s) => s.exitPvr)
  const hasLabels = !!meta?.cutoffs.some((c) => c.hasLabels && c.trained)
  return (
    <header className="pointer-events-auto flex h-14 items-center gap-4 border-b border-slate-800/80 bg-ink-900/85 px-4 backdrop-blur-md">
      <button onClick={() => navigate({ page: 'home' })} className="flex items-center gap-2.5" aria-label="Home" data-testid="home-button">
        <Logo size={26} />
        <span className="text-[15px] font-semibold tracking-tight">RepoCity</span>
      </button>
      <div className="h-5 w-px bg-slate-700" />
      {meta && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-slate-100" data-testid="repo-name">{meta.name}</span>
          {meta.url && (
            <a href={meta.url} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-slate-200" aria-label="Open repository">
              <Icon.External size={14} />
            </a>
          )}
          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">{meta.head.slice(0, 8)}</span>
        </div>
      )}
      <div className="flex-1" />
      <SearchBox />
      <div className="seg" role="group" aria-label="Mode">
        <button aria-pressed={mode === 'explore'} onClick={exitPvr} data-testid="mode-explore">
          Explore
        </button>
        <button aria-pressed={mode === 'pvr'} onClick={enterPvr} disabled={!hasLabels} title={hasLabels ? '' : 'Not enough history to evaluate predictions'} data-testid="mode-pvr">
          Prediction vs Reality
        </button>
      </div>
    </header>
  )
}

function SearchBox() {
  const layout = useCity((s) => s.layout)
  const snapshot = useCity((s) => s.snapshot)
  const select = useCity((s) => s.select)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const results = useMemo(() => {
    if (!layout || !snapshot) return []
    return searchPaths(layout.files.path, q, 10, (i) => snapshot.loc[i] > 0)
  }, [layout, snapshot, q])

  function choose(i: number) {
    select(i, true)
    setOpen(false)
    setQ(layout?.files.path[i] ?? '')
    input.current?.blur()
  }

  return (
    <div className="relative w-[340px]">
      <div className="flex h-9 items-center gap-2 rounded-[10px] border border-slate-700/70 bg-slate-900/80 px-3 text-slate-400 focus-within:border-sky-400/60">
        <Icon.Search size={15} />
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => Math.min(results.length - 1, a + 1))
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
            else if (e.key === 'Enter' && results[active] !== undefined) choose(results[active])
            else if (e.key === 'Escape') setOpen(false)
          }}
          placeholder="Find a file…"
          className="w-full bg-transparent text-[13px] text-slate-100 placeholder:text-slate-500 focus:outline-none"
          aria-label="Search files"
          data-testid="search-input"
        />
      </div>
      {open && q && (
        <ul className="panel absolute right-0 top-11 z-30 max-h-80 w-[440px] overflow-y-auto p-1 scroll-thin" role="listbox" data-testid="search-results">
          {results.length === 0 && <li className="px-3 py-2 text-[13px] text-slate-500">No file in this month matches “{q}”.</li>}
          {results.map((i, k) => {
            const p = layout!.files.path[i]
            const cut = p.lastIndexOf('/')
            return (
              <li key={i} role="option" aria-selected={k === active}>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                  className={`block w-full truncate rounded-lg px-3 py-1.5 text-left text-[13px] ${k === active ? 'bg-sky-400/15 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                >
                  <span className="text-slate-500">{p.slice(0, cut + 1)}</span>
                  <span className="font-medium">{p.slice(cut + 1)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
