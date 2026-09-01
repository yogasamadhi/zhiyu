import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: Number(process.env.WEB_PORT ?? 45173),
    proxy: {
      '/api': `http://127.0.0.1:${process.env.API_PORT ?? 45300}`,
      '/health': `http://127.0.0.1:${process.env.API_PORT ?? 45300}`,
      '/ready': `http://127.0.0.1:${process.env.API_PORT ?? 45300}`,
    },
  },
});
