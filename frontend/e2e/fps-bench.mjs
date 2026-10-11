// E7 frontend FPS benchmark: node e2e/fps-bench.mjs <baseUrl> <out.json> <n1> <n2> ...
// Opens /#/bench/N (synthetic, continuously animating city of N instanced buildings) in Chromium
// and records frames per second from requestAnimationFrame for 8 seconds after a 3 s warm-up.
import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'

const [, , base, out, ...counts] = process.argv
const headed = process.env.FPS_HEADED === '1'
const software = process.env.FPS_RENDERER === 'swiftshader'
const browser = await chromium.launch({
  headless: !headed,
  args: software
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', ...(process.env.FPS_UNCAPPED === '1' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const results = []
let renderer = 'unknown'
for (const n of counts.map(Number)) {
  await page.goto(`${base}/#/bench/${n}`)
  await page.waitForFunction(() => window.__repocity?.ready && window.__repocity.fps.length > 0, null, { timeout: 120000 })
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    window.__repocity.fps = []
    window.__repocity.updateMs = []
  })
  await page.waitForTimeout(8000)
  const fps = await page.evaluate(() => window.__repocity.fps.slice())
  const upd = await page.evaluate(() => window.__repocity.updateMs.slice().sort((a, b) => a - b))
  renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'
  })
  const sorted = [...fps].sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  results.push({ buildings: n, samples: fps, median_fps: q(0.5), p5_fps: q(0.05), median_update_ms: upd.length ? upd[Math.floor(upd.length / 2)] : null })
  console.log(`  ${n} buildings: median ${q(0.5).toFixed(1)} fps, JS update ${upd.length ? upd[Math.floor(upd.length / 2)].toFixed(2) : '?'} ms`)
}
const version = browser.version()
await browser.close()
writeFileSync(out, JSON.stringify({ status: 'ok', browser: version, headless: !headed, software, renderer, results }, null, 1))
