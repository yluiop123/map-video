import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  base: '/map-video/',
  server: {
    // 本机文件监听不可靠（改动不触发热更新），改用轮询
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
})
