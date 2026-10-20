import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.PORT || loadEnv(mode, process.cwd(), 'PORT').PORT || '3001'}`, changeOrigin: false } },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          chart: ['lightweight-charts'],
          react: ['react', 'react-dom'],
          schema: ['zod', 'zod-to-json-schema'],
        },
      },
    },
  },
  // Keep local checks within one worker on memory-constrained desktops.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', maxWorkers: 1, fileParallelism: false },
}));
