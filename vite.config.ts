import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The UI is a plain Vite app; Tauri serves the built files from dist/ and the dev server on 5173.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: resolve(__dirname, 'dist'), emptyOutDir: true, target: 'esnext' }
})
