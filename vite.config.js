import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/gb-grid-tool/',
  build: {
    outDir: 'dist'
  },
  optimizeDeps: {
    exclude: ['highs']  // Don't pre-bundle WASM module
  },
  test: {
    environment: 'node'
  }
})
