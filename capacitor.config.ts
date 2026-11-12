import type { CapacitorConfig } from '@capacitor/cli';

// VITE_ALLOW_LAN_HTTP=1 — отладочная сборка: приложению разрешено ходить на сервер по http:// в локальной сети.
// Релизная сборка (без переменной) работает только по https:// (Tailscale и т. п.).
const lanHttp = process.env.VITE_ALLOW_LAN_HTTP === '1';
// CAP_APP_ID_DEBUG=1 — флаг --debug у scripts/build-android.mjs: к идентификатору добавляется .debug,
// чтобы отладочная копия ставилась рядом с релизной, а к названию — «debug», чтобы копии не путались
// в списке приложений у телефона.
const debug = process.env.CAP_APP_ID_DEBUG === '1';
const appId = debug ? 'app.repforge.workout.debug' : 'app.repforge.workout';
const appName = debug ? 'repforge debug' : 'repforge';

const config: CapacitorConfig = {
  appId, // менять нужно до первой публикации: потом идентификатор уже не сменить
  appName,
  webDir: 'dist',
  // Приложение лежит внутри оболочки и открывается с https://localhost; удалённый адрес в WebView не грузим.
  server: { androidScheme: 'https' },
  android: { allowMixedContent: lanHttp },
  plugins: {
    LocalNotifications: { smallIcon: 'ic_stat_workout', iconColor: '#12161C' }
  }
};

export default config;
