import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 前端构建产物直接落到后端静态目录，由 @ots/server 托管（DESIGN.md §3.2）。
 * 开发模式下由 Vite 提供页面，并把 /api 代理到后端（默认 5174）。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.OTS_API_TARGET ?? 'http://127.0.0.1:5174',
        changeOrigin: true,
        ws: false,
      },
    },
  },
});
