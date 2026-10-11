import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Starts the backend (serving the offline demo cache) and the frontend, then runs e2e/*.spec.ts.
const root = path.resolve(here, '..')
const venvPython = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python')
const python = process.env.PYTHON ?? venvPython
const apiPort = Number(process.env.E2E_API_PORT ?? 8011)
const webPort = Number(process.env.E2E_WEB_PORT ?? 5199)

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  },
  webServer: [
    {
      command: `"${python}" -m uvicorn repocity.api.app:app --port ${apiPort}`,
      cwd: path.join(root, 'backend'),
      url: `http://127.0.0.1:${apiPort}/api/health`,
      env: { REPOCITY_DEMO_DIR: path.join(root, 'demo', 'cache'), REPOCITY_DATA_DIR: path.join(root, 'data', 'e2e') },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      env: { REPOCITY_API: `http://127.0.0.1:${apiPort}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
