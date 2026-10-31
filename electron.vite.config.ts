import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    assetsInclude: ['**/*.tflite', '**/*.task'],
    // MediaPipe's WASM loader needs importScripts(), i.e. a classic (non-module) worker.
    worker: { format: 'iife' }
  }
})
