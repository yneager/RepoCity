import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Opt-in (needs internet): E2E_LIVE=1 npx playwright test live
// Pastes a public URL, follows the SSE progress view and lands in the new city.
const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '..', '..', 'docs', 'screenshots')

test.skip(!process.env.E2E_LIVE, 'set E2E_LIVE=1 to run the live (network) analysis test')

test('paste a URL: live progress, then the city', async ({ page }) => {
  test.setTimeout(600_000)
  await page.goto('/')
  await page.getByTestId('repo-url').fill(process.env.E2E_LIVE_URL ?? 'https://github.com/pallets/click')
  await page.getByTestId('analyze-button').click()
  await expect(page.getByTestId('progress-panel')).toBeVisible()
  await expect(page.getByTestId('progress-log')).toContainText('[history]', { timeout: 120_000 })
  await page.screenshot({ path: path.join(SHOTS, '13-live-progress.png') })
  await expect(page.getByTestId('city-view')).toHaveAttribute('data-ready', 'true', { timeout: 540_000 })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: path.join(SHOTS, '14-live-city.png') })
})
