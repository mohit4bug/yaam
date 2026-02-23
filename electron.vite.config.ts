import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const sourcePath = resolve('src')
const rendererSourcePath = resolve('src/renderer/src')

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
    },
    resolve: {
      alias: {
        '@': sourcePath,
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
    resolve: {
      alias: {
        '@': sourcePath,
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': rendererSourcePath,
        '@renderer': rendererSourcePath,
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
