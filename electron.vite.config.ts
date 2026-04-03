import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    resolve: {
      alias: {
        '@': resolve('src')
      }
    },
    plugins: [react()],
    build: {
      sourcemap: false,
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, '/')

            if (normalizedId.includes('/node_modules/')) {
              if (
                normalizedId.includes('/react/') ||
                normalizedId.includes('/react-dom/') ||
                normalizedId.includes('/scheduler/')
              ) {
                return 'react-vendor'
              }

              if (normalizedId.includes('/@tanstack/react-virtual/')) {
                return 'virtual-list'
              }

              return 'renderer-vendor'
            }

          }
        }
      }
    }
  }
})
