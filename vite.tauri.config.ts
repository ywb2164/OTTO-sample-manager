import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: {
      '@': resolve('src')
    }
  },
  plugins: [react()],
  build: {
    sourcemap: false,
    target: 'chrome105',
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/')

          if (!normalizedId.includes('/node_modules/')) return undefined
          if (
            normalizedId.includes('/react/') ||
            normalizedId.includes('/react-dom/') ||
            normalizedId.includes('/scheduler/')
          ) {
            return 'react-vendor'
          }
          if (normalizedId.includes('/@tanstack/react-virtual/')) return 'virtual-list'
          if (normalizedId.includes('/@tauri-apps/')) return 'tauri-runtime'
          return 'renderer-vendor'
        }
      }
    }
  },
  server: {
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  }
})
