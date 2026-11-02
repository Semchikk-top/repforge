import type { CapacitorConfig } from '@capacitor/cli';

// VITE_ALLOW_LAN_HTTP=1 — отладочная сборка: приложению разрешено ходить на сервер по http:// в локальной сети.
// Релизная сборка (без переменной) работает только по https:// (Tailscale и т. п.).
const lanHttp = process.env.VITE_ALLOW_LAN_HTTP === '1';

const config: CapacitorConfig = {
  appId: 'app.repforge.workout', // менять нужно до первой публикации: потом идентификатор уже не сменить
  appName: 'repforge',
  webDir: 'dist',
  // Приложение лежит внутри оболочки и открывается с https://localhost; удалённый адрес в WebView не грузим.
  server: { androidScheme: 'https' },
  android: { allowMixedContent: lanHttp },
  plugins: {
    LocalNotifications: { smallIcon: 'ic_stat_workout', iconColor: '#12161C' }
  }
};

export default config;
