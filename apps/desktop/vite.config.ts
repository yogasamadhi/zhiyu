import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.DESKTOP_RENDERER_PORT ?? 45174),
    strictPort: true,
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'src/renderer/index.html'),
        credential: resolve(import.meta.dirname, 'src/renderer/credential.html'),
      },
    },
  },
});
