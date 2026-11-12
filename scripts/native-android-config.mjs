// Запускается после `cap sync android` (см. package.json: cap:sync). Включает открытый HTTP только в отладочной сборке
// (VITE_ALLOW_LAN_HTTP=1); без переменной возвращает запрет. Релиз по умолчанию ходит только по https://.
import { readFileSync, writeFileSync } from 'node:fs';
import { ensureTtsQueries } from './android-manifest.mjs';

const manifest = new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url);
const lan = process.env.VITE_ALLOW_LAN_HTTP === '1';
const before = readFileSync(manifest, 'utf8');
const after = ensureTtsQueries(before).replace(/android:usesCleartextTraffic="(true|false)"/, `android:usesCleartextTraffic="${lan}"`);
if (after === before && !before.includes('usesCleartextTraffic')) {
  console.error('В AndroidManifest.xml нет usesCleartextTraffic: проверь манифест.');
  process.exit(1);
}
if (after !== before) writeFileSync(manifest, after);
console.log('Android: системный движок озвучки виден приложению (queries TTS_SERVICE)');
console.log(`Android: открытый HTTP ${lan ? 'РАЗРЕШЁН (отладочная сборка для локальной сети)' : 'запрещён (релизная настройка)'}`);

// `cap sync` не переписывает app_name в strings.xml — это делает только `cap add` при создании проекта.
// Поэтому название из сгенерированного capacitor.config.json (там оно уже с учётом CAP_APP_ID_DEBUG)
// подставляем сами: в debug-сборке это «repforge debug», чтобы копия не путалась с релизной в списке
// приложений.
const capConfig = JSON.parse(readFileSync(new URL('../android/app/src/main/assets/capacitor.config.json', import.meta.url), 'utf8'));
const stringsFile = new URL('../android/app/src/main/res/values/strings.xml', import.meta.url);
const stringsBefore = readFileSync(stringsFile, 'utf8');
const label = String(capConfig.appName).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stringsAfter = stringsBefore
  .replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${label}$2`)
  .replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, `$1${label}$2`);
if (stringsAfter !== stringsBefore) writeFileSync(stringsFile, stringsAfter);
console.log(`Android: название приложения «${capConfig.appName}»`);
