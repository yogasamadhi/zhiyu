import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3101,
    proxy: {
      '/api/cloud/v1': {
        target: process.env.CLOUD_SERVER_URL ?? 'http://127.0.0.1:3200',
        changeOrigin: false,
      },
    },
  },
});
