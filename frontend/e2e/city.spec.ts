import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// End-to-end: home -> demo city -> timeline -> hover/click -> search -> encodings -> Prediction vs Reality.
// Screenshots are written to docs/screenshots for the report and README.
const SHOTS = path.resolve(here, '..', '..', 'docs', 'screenshots')
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) })

async function settle(page: Page, ms = 1800) {
  // let building animations converge before measuring or taking screenshots
  await page.waitForTimeout(ms)
}

async function openDemo(page: Page) {
  await page.goto('/')
  const card = page.locator('[data-testid^="demo-pallets-flask"]')
  await expect(card).toBeVisible()
  await shot(page, '01-home')
  await card.click()
  await expect(page.getByTestId('city-view')).toHaveAttribute('data-ready', 'true')
  await page.waitForFunction(() => (window.__repocity?.fps.length ?? 0) > 0)
  await settle(page)
}

async function buildingScreenPos(page: Page) {
  return page.evaluate(() => {
    const api = window.__repocity!
    const i = api.tallest!()
    return { i, ...api.screenOf!(i) }
  })
}

test('demo city: timeline, picking, search, encodings', async ({ page }) => {
  const t0 = Date.now()
  await openDemo(page)
  expect(Date.now() - t0).toBeLessThan(15_000)
  await expect(page.getByTestId('repo-name')).toHaveText('pallets/flask')
  await shot(page, '02-city-latest')

  // timeline: jump to three dates and check the city grows
  const slider = page.getByTestId('timeline-slider')
  const max = Number(await slider.getAttribute('max'))
  const filesAt = async (idx: number) => {
    await slider.fill(String(idx))
    await settle(page, 2200)
    return Number(await page.getByTestId('stat-files').textContent())
  }
  const early = await filesAt(Math.round(max * 0.1))
  await expect(page.getByTestId('timeline-date')).not.toHaveText('')
  await shot(page, '03-timeline-early')
  const mid = await filesAt(Math.round(max * 0.5))
  await shot(page, '04-timeline-middle')
  const late = await filesAt(max)
  await shot(page, '05-timeline-latest')
  expect(early).toBeLessThan(late)
  expect(mid).toBeGreaterThan(0)

  // play / pause
  await slider.fill(String(Math.round(max * 0.3)))
  const before = await page.getByTestId('timeline-date').textContent()
  await page.getByTestId('play-button').click()
  await page.waitForTimeout(1500)
  await page.getByTestId('play-button').click()
  expect(await page.getByTestId('timeline-date').textContent()).not.toBe(before)
  await slider.fill(String(max))
  await settle(page)

  // hover shows a tooltip, click opens the file panel
  const pos = await buildingScreenPos(page)
  expect(pos.visible).toBe(true)
  await page.mouse.move(pos.x, pos.y)
  await expect(page.getByTestId('tooltip')).toBeVisible()
  await page.mouse.click(pos.x, pos.y)
  await expect(page.getByTestId('file-panel')).toBeVisible()
  await expect(page.getByTestId('sparkline')).toBeVisible()
  await expect(page.getByTestId('shap-bars')).toBeVisible()
  await settle(page, 800)
  await shot(page, '06-file-panel')
  await page.getByTestId('file-panel-close').click()

  // search flies to a file
  await page.getByTestId('search-input').fill('app.py')
  await expect(page.getByTestId('search-results')).toBeVisible()
  await page.getByTestId('search-input').press('Enter')
  await expect(page.getByTestId('file-panel-name')).toHaveText('app.py')
  await settle(page, 1500)
  await shot(page, '07-search-fly-to')
  await page.getByTestId('file-panel-close').click()

  // encodings (back to the overview first)
  await page.getByTestId('reset-view').click()
  await page.getByTestId('height-complexity').click()
  await page.getByTestId('color-authors').click()
  await settle(page)
  await expect(page.getByTestId('legend')).toContainText('author')
  await shot(page, '08-encoding-complexity-authors')
  await page.getByTestId('color-bugs').click()
  await page.getByTestId('height-churn').click()
  await settle(page)
  await shot(page, '09-encoding-bug-history')
})

test('prediction vs reality: reveal and score card match the backend', async ({ page, request }) => {
  await openDemo(page)
  await page.getByTestId('mode-pvr').click()
  await expect(page.getByTestId('reveal-button')).toBeVisible()
  await settle(page)
  await shot(page, '10-pvr-predicted')
  const cutoff = await page.getByTestId('pvr-cutoff').inputValue()
  await page.getByTestId('reveal-button').click()
  await expect(page.getByTestId('score-card')).toBeVisible()
  await settle(page, 2500)
  await shot(page, '11-pvr-revealed')

  // the numbers shown must be the backend's evaluation numbers
  const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2])
  const pred = await (await request.get(`/api/analyses/${id}/predictions?cutoff=${cutoff}`)).json()
  const k = 20
  const hits = Number(await page.getByTestId('hits-value').textContent())
  expect(hits).toBeCloseTo(pred.metrics[pred.model].p_at_20 * k, 6)
  const recall = (await page.getByTestId('card-model-recall').textContent())!.replace('%', '')
  expect(Number(recall)).toBe(Math.round(pred.metrics[pred.model].recall_20loc * 100))
  const hotRecall = (await page.getByTestId('card-hotspot-recall').textContent())!.replace('%', '')
  expect(Number(hotRecall)).toBe(Math.round(pred.metrics.hotspot.recall_20loc * 100))

  // k = 10 uses the same ranking -> equals backend precision@10
  await page.getByTestId('pvr-k-10').click()
  const hits10 = Number(await page.getByTestId('hits-value').textContent())
  expect(hits10).toBeCloseTo(pred.metrics[pred.model].p_at_10 * 10, 6)

  // the "evaluation cutoff" list matches the backend's E1 cutoffs
  const meta = await (await request.get(`/api/analyses/${id}/meta`)).json()
  expect(meta.evalCutoffs).toContain(cutoff)
})

test('error states: invalid URL and unknown analysis', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('repo-url').fill('ftp://example.com/repo')
  await page.getByTestId('analyze-button').click()
  await expect(page.getByTestId('url-error')).toBeVisible()
  await shot(page, '12-invalid-url')
  await page.goto('/#/city/does-not-exist')
  await expect(page.getByTestId('city-error')).toBeVisible()
})
