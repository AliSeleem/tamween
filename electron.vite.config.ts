import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  // Runtime libraries (exceljs) are bundled into the main script instead of shipping node_modules,
  // which keeps the installer small. Only Electron itself stays external.
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { minify: true }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: shared },
    plugins: [react()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } }
  }
})
