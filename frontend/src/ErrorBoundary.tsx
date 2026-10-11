import { Component, type ReactNode } from 'react'

/** Shows a readable error instead of a blank page if rendering throws. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" role="alert">
        <div className="text-[18px] font-semibold text-rose-200">Something went wrong while drawing the city.</div>
        <pre className="max-w-xl whitespace-pre-wrap text-[12px] text-slate-400">{this.state.error.message}</pre>
        <button
          className="rounded-lg bg-sky-500 px-4 py-2 text-[14px] font-semibold text-slate-950"
          onClick={() => {
            window.location.hash = '#/'
            window.location.reload()
          }}
        >
          Back to start
        </button>
      </div>
    )
  }
}
