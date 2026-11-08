// Идентификатор Android-приложения. Отладочная сборка (флаг --debug в scripts/build-android.mjs)
// получает суффикс .debug, поэтому её можно поставить рядом с релизной, не заменяя её.
export const BASE_APP_ID = 'app.repforge.workout';

export function appId(debug) {
  return debug ? `${BASE_APP_ID}.debug` : BASE_APP_ID;
}
