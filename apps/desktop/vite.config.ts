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
    // The Renderer has its own dedicated subdirectory under dist. Clear it on
    // every production build so fixture scans inspect only the current bundle,
    // while the Electron main/preload artifacts in the parent remain intact.
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'src/renderer/index.html'),
        credential: resolve(import.meta.dirname, 'src/renderer/credential.html'),
      },
    },
  },
});
