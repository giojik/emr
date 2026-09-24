import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// dev: /api → backend (იგივე origin, CORS არ სჭირდება; refresh cookie მუშაობს)
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: process.env.API_TARGET ?? 'http://127.0.0.1:3000', changeOrigin: false } } },
  preview: { port: 4173, proxy: { '/api': { target: process.env.API_TARGET ?? 'http://127.0.0.1:3000', changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: true },
});
