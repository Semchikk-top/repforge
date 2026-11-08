// Сборка отладочного APK Android.
//
//   npm run android:build              # обычный debug APK (app.repforge.workout)
//   npm run android:build -- --debug   # APK с идентификатором app.repforge.workout.debug
//
// Флаг --debug добавляет к идентификатору приложения суффикс .debug: такую копию можно
// поставить рядом с релизной, не заменяя её. Идентификатор попадает в Gradle (-PappIdSuffix)
// и в capacitor.config.ts (CAP_APP_ID_DEBUG) до вызова cap sync.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appId } from './android-app-id.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const debug = process.argv.includes('--debug');
const env = { ...process.env, CAP_APP_ID_DEBUG: debug ? '1' : '0' };

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npm', ['run', 'build:native']);
run('npx', ['cap', 'sync', 'android']);
run(process.execPath, ['scripts/native-android-config.mjs']);
// Суффикс передаём и в Gradle: сборка не зависит от того, остался ли он в файлах после прошлого запуска.
run('./gradlew', ['assembleDebug', `-PappIdSuffix=${debug ? '.debug' : ''}`], `${root}android`);

const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
const built = `${root}android/app/build/outputs/apk/debug/app-debug.apk`;
if (!existsSync(built)) {
  console.error(`Gradle не оставил APK: ${built}`);
  process.exit(1);
}
const out = `${root}repforge-${pkg.version}-debug.apk`;
copyFileSync(built, out);
console.log(`APK: ${out}`);
console.log(`applicationId: ${appId(debug)}`);
