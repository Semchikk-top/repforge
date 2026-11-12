// Проверка копии до записи и предпросмотр восстановления. Одна функция decide() решает судьбу каждой записи и для
// предпросмотра, и для самого импорта, поэтому показанное пользователю и выполненное не могут разойтись.
import { DEFAULT_SETTINGS, type Settings } from '../domain/types';
import { db } from './db';

export const BACKUP_FORMAT = 1;
export const BACKUP_TABLES = ['exercises', 'workouts', 'templates', 'body', 'programs', 'game', 'checkins', 'tracks', 'learning'] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];

export interface BackupRow { id: string; updatedAt: number; [k: string]: unknown }
export type BackupData = { version: number; exportedAt?: number; settings?: unknown; counts?: Record<string, number> } & Partial<Record<BackupTable, BackupRow[]>>;
/** Сколько непригодных записей пропущено в каждом разделе: они не пишутся, но пользователь о них знает. */
export type Skipped = Partial<Record<BackupTable, number>>;

/** add — записи нет на устройстве; replace — в копии новее; same — одинаковая версия; keep — на устройстве новее, копия её не тронет. */
export type Decision = 'add' | 'replace' | 'same' | 'keep';

export function decide(local: { updatedAt: number } | undefined, incoming: { updatedAt: number }): Decision {
  if (!local) return 'add';
  if (local.updatedAt < incoming.updatedAt) return 'replace';
  return local.updatedAt === incoming.updatedAt ? 'same' : 'keep';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Что с записью не так; null, если она годится. Проверяем то, без чего экраны приложения падают. */
function rowProblem(table: BackupTable, r: unknown): string | null {
  if (!isObj(r)) return 'не объект';
  if (typeof r.id !== 'string' || !r.id) return 'нет id';
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return 'нет времени изменения';
  if (table === 'workouts' && (typeof r.date !== 'string' || !Array.isArray(r.exercises))) return 'нет даты или упражнений';
  if (table === 'checkins' && r.slot !== 'morning' && r.slot !== 'evening') return 'неизвестный слот';
  if (table === 'learning' && (typeof r.courseId !== 'string' || typeof r.passed !== 'boolean' || typeof r.correct !== 'number' || typeof r.total !== 'number' || r.total <= 0)) return 'неполная попытка теста';
  return null;
}

export type Validated = { ok: true; data: BackupData; skipped: Skipped } | { ok: false; error: string };

/**
 * Разбор и проверка текста копии: формат, версия, структура разделов, сверка счётчиков. Ничего не пишет.
 * Отдельные непригодные записи отбрасываются и учитываются в skipped (так восстановление спасает всё, что можно);
 * файл целиком отвергается, только если он не копия, чужой версии, обрезан или структурно испорчен.
 */
export function validateBackup(json: string): Validated {
  let data: unknown;
  try { data = JSON.parse(json); } catch { return { ok: false, error: 'Файл повреждён: это не корректный JSON. Копия не тронута.' }; }
  if (!isObj(data) || typeof data.version !== 'number') return { ok: false, error: 'Неизвестный формат файла: это не копия данных приложения.' };
  if (data.version > BACKUP_FORMAT) return { ok: false, error: `Копия сделана более новой версией приложения (формат ${data.version}). Обнови приложение и повтори.` };
  if (data.version !== BACKUP_FORMAT) return { ok: false, error: 'Неизвестный формат файла' };
  const skipped: Skipped = {};
  const clean: Partial<Record<BackupTable, BackupRow[]>> = {};
  for (const t of BACKUP_TABLES) {
    const rows = data[t];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) return { ok: false, error: `Копия повреждена: раздел «${t}» не список.` };
    const good = rows.filter((r) => rowProblem(t, r) === null) as BackupRow[];
    if (good.length < rows.length) skipped[t] = rows.length - good.length;
    if (new Set(good.map((r) => r.id)).size !== good.length) return { ok: false, error: `Копия повреждена: в разделе «${t}» повторяются номера записей.` };
    clean[t] = good;
  }
  if (isObj(data.counts)) {
    for (const t of BACKUP_TABLES) {
      const n = (data.counts as Record<string, unknown>)[t];
      if (typeof n === 'number' && n !== ((data[t] as unknown[] | undefined)?.length ?? 0)) return { ok: false, error: `Копия неполная: в разделе «${t}» должно быть ${n} записей, а в файле ${(data[t] as unknown[] | undefined)?.length ?? 0}.` };
    }
  }
  return { ok: true, data: { ...(data as BackupData), ...clean }, skipped };
}

export interface TableDiff { total: number; add: number; replace: number; same: number; keep: number }
export type BackupPreview =
  | { ok: false; error: string }
  | { ok: true; exportedAt: number | null; tables: Record<BackupTable, TableDiff>; totals: TableDiff & { conflicts: number }; hasSettings: boolean; skipped: number };

const empty = (): TableDiff => ({ total: 0, add: 0, replace: 0, same: 0, keep: 0 });

/**
 * Предпросмотр: что добавится, что заменится, что останется как есть. conflicts — записи, которые есть и в копии, и на
 * устройстве в разных версиях (заменятся или будут пропущены), то есть места, где что-то изменено с обеих сторон.
 */
export async function inspectBackup(json: string): Promise<BackupPreview> {
  const v = validateBackup(json);
  if (!v.ok) return v;
  const tables = {} as Record<BackupTable, TableDiff>;
  const totals = empty();
  for (const t of BACKUP_TABLES) {
    const diff = empty();
    const rows = v.data[t] ?? [];
    const local = await (db[t] as unknown as { bulkGet(ids: string[]): Promise<({ updatedAt: number } | undefined)[]> }).bulkGet(rows.map((r) => r.id));
    rows.forEach((r, i) => { diff.total++; diff[decide(local[i], r)]++; });
    tables[t] = diff;
    (Object.keys(totals) as (keyof TableDiff)[]).forEach((k) => { totals[k] += diff[k]; });
  }
  return { ok: true, exportedAt: typeof v.data.exportedAt === 'number' ? v.data.exportedAt : null, tables, totals: { ...totals, conflicts: totals.replace + totals.keep }, hasSettings: isObj(v.data.settings), skipped: Object.values(v.skipped).reduce<number>((a, n) => a + (n ?? 0), 0) };
}

// ---------- настройки из копии ----------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ENUMS: Partial<Record<keyof Settings, readonly string[]>> = { theme: ['auto', 'dark', 'light'], analyticsMode: ['basic', 'deep'], assistantBackend: ['cloud', 'local', 'agent'] };
const TIMES: readonly (keyof Settings)[] = ['reminderTime', 'checkinMorningTime', 'checkinEveningTime'];

/**
 * Настройки из файла копии: оставляем только известные поля с подходящим типом и разумным значением.
 * Копия может быть чужой, старой или испорченной, а неверный тип в настройках ломает экраны (например, plates не список).
 * Недопустимое поле просто заменяется значением по умолчанию.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (!isObj(raw)) return out as unknown as Settings;
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS) as [keyof Settings, unknown][]) {
    const v = raw[key];
    if (v === undefined) continue;
    if (Array.isArray(def)) { if (Array.isArray(v) && v.length <= 30 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 1000)) out[key] = v; continue; }
    if (typeof v !== typeof def) continue;
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0 || v > 1_000_000)) continue;
    if (ENUMS[key] && !ENUMS[key]!.includes(v as string)) continue;
    if (TIMES.includes(key) && !HHMM.test(v as string)) continue;
    out[key] = v;
  }
  if (typeof raw.assistantBackend === 'string' && ENUMS.assistantBackend!.includes(raw.assistantBackend)) out.assistantBackend = raw.assistantBackend;
  return out as unknown as Settings;
}
