// Screenshot support: the scene registers a function that renders one frame and returns a PNG data URL.
let captureFn: (() => string) | null = null

export function setCapture(fn: (() => string) | null): void {
  captureFn = fn
}

/** Save the current view as a PNG (triggered by the user's click). */
export function downloadScreenshot(filename: string): boolean {
  if (!captureFn) return false
  const url = captureFn()
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  return true
}
