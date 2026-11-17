import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const { PORT = '3000' } = loadEnv(mode, resolve(import.meta.dirname, '../..'), 'PORT');
  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'prompt',
        manifest: {
          name: '下一站 NextStop',
          short_name: '下一站',
          lang: 'zh-CN',
          start_url: '/',
          display: 'standalone',
          background_color: '#f5f4ef',
          theme_color: '#285d4b',
          icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg}'],
          navigateFallbackDenylist: [/^\/api\//, /^\/health\//],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/health': { target: `http://127.0.0.1:${process.env.PORT ?? PORT}` },
        '/api': { target: `http://127.0.0.1:${process.env.PORT ?? PORT}` },
      },
    },
  };
});
