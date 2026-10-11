/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The backend runs on :8000 natively and as the `backend` service in Docker Compose.
const API_TARGET = process.env.REPOCITY_API ?? 'http://127.0.0.1:8000'
const proxy = { '/api': { target: API_TARGET, changeOrigin: true } }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, host: true, proxy },
  preview: { port: 5173, host: true, proxy },
  build: { chunkSizeWarningLimit: 2000 },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
})
