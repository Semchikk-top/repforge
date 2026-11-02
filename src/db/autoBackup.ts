// Автоматические копии данных внутри приложения (нативная оболочка): раз в сутки, зашифрованные ключом из
// Keystore, с ротацией. Это защита от потери данных WebView, а не от потери телефона: для этого есть синхронизация
// с сервером и «Экспорт» (с паролем).
import { platform } from '../platform';
import type { BackupFile } from '../platform/types';
import { db } from './db';
import { decryptBackup, encryptBackup, newBackupKey, parseEnvelope } from './backupCrypto';
import { exportAll, importAll, loadSettings } from './repo';

export const BACKUP_KEY_ID = 'backup.key';
const LAST_AT = 'backup.lastAt';
const DECLINED = 'backup.offerDeclined';
export const MIN_INTERVAL_MS = 20 * 3600_000;
const DAY = 86_400_000;

// ---------- имена и ротация (чистая логика) ----------
export const backupFileName = (version: string, d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `auto_${version}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.rfb`;
};

export interface ParsedName { version: string; date: string; day: number }
const NAME_RE = /^auto_([0-9A-Za-z.+-]+)_(\d{4})-(\d{2})-(\d{2})\.rfb$/;
export function parseBackupName(name: string): ParsedName | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const day = Math.floor(Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4])) / DAY);
  return { version: m[1], date: `${m[2]}-${m[3]}-${m[4]}`, day };
}

const semverKey = (v: string): number[] => v.split(/[.+-]/).map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0));
const cmpVersion = (a: string, b: string): number => {
  const x = semverKey(a), y = semverKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
const weekOf = (day: number): number => Math.floor((day + 3) / 7); // недели с понедельника (1970-01-01 был четвергом)

export const KEEP_DAILY = 7;
export const KEEP_WEEKLY = 4;
export const KEEP_VERSIONS = 3;

/**
 * Что удалить. Остаются: 7 последних копий; по одной на каждую из 4 предыдущих недель; последняя копия каждой из
 * 3 последних версий приложения (снимок «до обновления», чтобы откат был возможен). Чужие имена не трогаем.
 */
export function pickBackupsToDelete(files: Pick<BackupFile, 'name'>[]): string[] {
  const parsed = files.map((f) => ({ name: f.name, p: parseBackupName(f.name) })).filter((x): x is { name: string; p: ParsedName } => !!x.p)
    .sort((a, b) => b.p.day - a.p.day || cmpVersion(b.p.version, a.p.version));
  const keep = new Set<string>();
  parsed.slice(0, KEEP_DAILY).forEach((x) => keep.add(x.name));
  const older = parsed.slice(KEEP_DAILY);
  const seenWeeks = new Set<number>();
  for (const x of older) {
    const w = weekOf(x.p.day);
    if (!seenWeeks.has(w) && seenWeeks.size < KEEP_WEEKLY) { seenWeeks.add(w); keep.add(x.name); }
  }
  const versions = [...new Set(parsed.map((x) => x.p.version))].sort(cmpVersion).reverse().slice(0, KEEP_VERSIONS);
  for (const v of versions) { const newest = parsed.find((x) => x.p.version === v); if (newest) keep.add(newest.name); }
  return parsed.filter((x) => !keep.has(x.name)).map((x) => x.name);
}

// ---------- работа с хранилищем ----------
export const autoBackupSupported = (): boolean => platform.backups.available && platform.secureStorage.hardwareBacked;

async function getKey(create: boolean): Promise<string | null> {
  const have = await platform.secureStorage.get(BACKUP_KEY_ID);
  if (have || !create) return have;
  const k = newBackupKey();
  await platform.secureStorage.set(BACKUP_KEY_ID, k);
  return k;
}

/** Данных нет вообще: пустую копию делать нельзя, иначе она вытеснит хорошие при ротации. */
export async function isDataEmpty(): Promise<boolean> {
  const [w, b, t, c] = await Promise.all([db.workouts.count(), db.body.count(), db.tracks.count(), db.checkins.count()]);
  return w + b + t + c === 0;
}

export type BackupResult = 'done' | 'skipped-recent' | 'skipped-empty' | 'skipped-off' | 'unavailable';

export async function runAutoBackup(opts: { force?: boolean; now?: number } = {}): Promise<BackupResult> {
  if (!autoBackupSupported()) return 'unavailable';
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    if (!(await loadSettings()).autoBackup) return 'skipped-off';
    const last = (await db.kv.get(LAST_AT))?.value as number | undefined;
    if (last && now - last < MIN_INTERVAL_MS) return 'skipped-recent';
  }
  if (await isDataEmpty()) return 'skipped-empty';

  const key = (await getKey(true))!;
  const text = await encryptBackup(await exportAll(), { kind: 'key', key });
  await platform.backups.write(backupFileName(platform.info.version, new Date(now)), text);
  await db.kv.put({ key: LAST_AT, value: now });
  const files = await platform.backups.list();
  for (const name of pickBackupsToDelete(files)) await platform.backups.remove(name);
  return 'done';
}

export const listAutoBackups = async (): Promise<Array<BackupFile & { parsed: ParsedName }>> =>
  (await platform.backups.list())
    .map((f) => ({ ...f, parsed: parseBackupName(f.name) }))
    .filter((f): f is BackupFile & { parsed: ParsedName } => !!f.parsed)
    .sort((a, b) => b.parsed.day - a.parsed.day || cmpVersion(b.parsed.version, a.parsed.version));

export const lastBackupAt = async (): Promise<number | null> => ((await db.kv.get(LAST_AT))?.value as number | undefined) ?? null;

/** Читает копию и возвращает JSON данных (для предпросмотра и восстановления). */
export async function readAutoBackup(name: string): Promise<string> {
  const key = await getKey(false);
  if (!key) throw new Error('Ключ автокопий в защищённом хранилище не найден: эту копию расшифровать нельзя');
  return decryptBackup(await platform.backups.read(name), { kind: 'key', key });
}

export async function restoreAutoBackup(name: string): Promise<{ exercises: number; workouts: number; templates: number }> {
  return importAll(await readAutoBackup(name));
}

/**
 * Данных на устройстве нет, а копия есть (WebView потерял хранилище или приложение поставили заново без ключа?):
 * возвращает самую свежую копию, которую ещё не отклоняли.
 */
export async function findRestoreOffer(): Promise<{ name: string; workouts: number; at: number } | null> {
  if (!autoBackupSupported() || !(await isDataEmpty())) return null;
  const newest = (await listAutoBackups())[0];
  if (!newest) return null;
  if (((await db.kv.get(DECLINED))?.value as string | undefined) === newest.name) return null;
  try {
    const data = JSON.parse(await readAutoBackup(newest.name)) as { workouts?: unknown[] };
    const workouts = Array.isArray(data.workouts) ? data.workouts.length : 0;
    return workouts > 0 ? { name: newest.name, workouts, at: newest.mtime || newest.parsed.day * DAY } : null;
  } catch { return null; }
}
export const declineRestoreOffer = (name: string) => db.kv.put({ key: DECLINED, value: name });

/** Пароль при импорте: обычная копия читается как есть, зашифрованная требует пароль (или ключ приложения). */
export async function openBackupText(text: string, askPassword: () => string | null): Promise<string> {
  const env = parseEnvelope(text);
  if (!env) return text;
  if (env.kdf === 'raw') {
    const key = await getKey(false);
    if (!key) throw new Error('Копия зашифрована ключом другого приложения или установки. Её можно открыть только там, где она создана.');
    return decryptBackup(text, { kind: 'key', key });
  }
  const pass = askPassword();
  if (pass === null) throw new Error('Импорт отменён');
  return decryptBackup(text, { kind: 'password', pass });
}
