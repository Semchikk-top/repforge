// Запускается после `cap sync android` (см. package.json: cap:sync). Включает открытый HTTP только в отладочной сборке
// (VITE_ALLOW_LAN_HTTP=1); без переменной возвращает запрет. Релиз по умолчанию ходит только по https://.
import { readFileSync, writeFileSync } from 'node:fs';

const manifest = new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url);
const lan = process.env.VITE_ALLOW_LAN_HTTP === '1';
const before = readFileSync(manifest, 'utf8');
const after = before.replace(/android:usesCleartextTraffic="(true|false)"/, `android:usesCleartextTraffic="${lan}"`);
if (after === before && !before.includes('usesCleartextTraffic')) {
  console.error('В AndroidManifest.xml нет usesCleartextTraffic: проверь манифест.');
  process.exit(1);
}
if (after !== before) writeFileSync(manifest, after);
console.log(`Android: открытый HTTP ${lan ? 'РАЗРЕШЁН (отладочная сборка для локальной сети)' : 'запрещён (релизная настройка)'}`);
