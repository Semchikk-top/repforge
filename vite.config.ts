import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// `vite build --mode native` — сборка для Capacitor: без service worker и манифеста PWA.
export default defineConfig(({ mode }) => {
  const native = mode === 'native';
  return {
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: native ? { alias: { 'virtual:pwa-register': fileURLToPath(new URL('./src/platform/pwa-stub.ts', import.meta.url)) } } : undefined,
  build: {
    rollupOptions: {
      output: {
        // Код нативной оболочки и плагинов Capacitor грузится только внутри приложения: в браузерной сборке
        // он лежит одним отдельным файлом, который не попадает в precache service worker.
        manualChunks: (id: string) => (id.includes('/@capacitor') || id.includes('/@aparajita/capacitor') || id.includes('/platform/native') ? 'native-shell' : undefined)
      }
    }
  },
  plugins: [
    react(),
    ...(native ? [] : [VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'repforge',
        short_name: 'repforge',
        description: 'Личный дневник тренировок: работает офлайн',
        lang: 'ru',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#12161c',
        theme_color: '#12161c',
        shortcuts: [
          { name: 'Начать тренировку', short_name: 'Старт', url: '/#/quick/start', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] },
          { name: 'Текущая тренировка', short_name: 'Тренировка', url: '/#/quick/current', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] },
          { name: 'Рекорды', short_name: 'Рекорды', url: '/#/records', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] }
        ],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // woff не нужен: современные браузеры берут woff2, а старый формат удваивал precache.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // карта (MapLibre ≈ 1,6 МБ) нужна только тому, кто нажал «Показать карту»: в предзагрузку не кладём
        globIgnores: ['**/native-shell-*.js', '**/maplibre-gl-*'],
        navigateFallbackDenylist: [/^\/api\//]
      }
    })])
  ]
  };
});
