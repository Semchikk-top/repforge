import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/db';
import { decryptBackup, encryptBackup, newBackupKey, parseEnvelope } from '../../src/db/backupCrypto';
import {
  backupFileName, declineRestoreOffer, findRestoreOffer, listAutoBackups, openBackupText, parseBackupName,
  pickBackupsToDelete, restoreAutoBackup, runAutoBackup
} from '../../src/db/autoBackup';
import { putWorkout, saveSettings, loadSettings } from '../../src/db/repo';
import { setPlatform } from '../../src/platform';
import { createWebPlatform } from '../../src/platform/web';
import type { BackupFile, Platform } from '../../src/platform/types';
import type { Workout } from '../../src/domain/types';

const FAST = 1000; // итераций PBKDF2 в тестах (в приложении — 310 000)

describe('шифрование копий', () => {
  it('пароль: туда и обратно; чужой пароль и порча файла не проходят', async () => {
    const text = await encryptBackup('{"секрет":"данные"}', { kind: 'password', pass: 'верный' }, FAST);
    expect(text).not.toContain('секрет');
    expect(parseEnvelope(text)).toMatchObject({ kdf: 'pbkdf2', iters: FAST });
    expect(await decryptBackup(text, { kind: 'password', pass: 'верный' })).toBe('{"секрет":"данные"}');
    await expect(decryptBackup(text, { kind: 'password', pass: 'чужой' })).rejects.toThrow(/Неверный пароль/);

    const env = JSON.parse(text);
    env.ct = env.ct.slice(0, -4) + (env.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(decryptBackup(JSON.stringify(env), { kind: 'password', pass: 'верный' })).rejects.toThrow();
    const tampered = JSON.parse(text);
    tampered.iters = FAST + 1; // параметры ключа подменить нельзя: ключ выйдет другим
    await expect(decryptBackup(JSON.stringify(tampered), { kind: 'password', pass: 'верный' })).rejects.toThrow();
  });

  it('ключ приложения: туда и обратно; один и тот же текст каждый раз шифруется по-разному', async () => {
    const key = newBackupKey();
    const a = await encryptBackup('данные', { kind: 'key', key });
    const b = await encryptBackup('данные', { kind: 'key', key });
    expect(a).not.toBe(b);
    expect(await decryptBackup(a, { kind: 'key', key })).toBe('данные');
    await expect(decryptBackup(a, { kind: 'key', key: newBackupKey() })).rejects.toThrow(/ключ приложения другой/);
  });

  it('режимы не путаются, обычный экспорт не принимается за зашифрованный', async () => {
    const byKey = await encryptBackup('x', { kind: 'key', key: newBackupKey() });
    await expect(decryptBackup(byKey, { kind: 'password', pass: 'p' })).rejects.toThrow(/ключом приложения/);
    const byPass = await encryptBackup('x', { kind: 'password', pass: 'p' }, FAST);
    await expect(decryptBackup(byPass, { kind: 'key', key: newBackupKey() })).rejects.toThrow(/паролем/);
    expect(parseEnvelope(JSON.stringify({ version: 1, workouts: [] }))).toBeNull();
    expect(parseEnvelope('не json')).toBeNull();
    expect(parseEnvelope('{"app":"repforge","kind":"backup","v":2}')).toBeNull();
  });
});

describe('ротация автокопий', () => {
  const day = (n: number, v = '0.6.0') => backupFileName(v, new Date(2026, 9, 30 - n));
  const names = (ds: number[], v = '0.6.0') => ds.map((n) => ({ name: day(n, v) }));

  it('имя копии разбирается обратно', () => {
    expect(day(0)).toBe('auto_0.6.0_2026-10-30.rfb');
    expect(parseBackupName('auto_0.6.0_2026-10-30.rfb')).toMatchObject({ version: '0.6.0', date: '2026-10-30' });
    expect(parseBackupName('мои-заметки.txt')).toBeNull();
  });

  it('до 7 копий ничего не удаляется', () => {
    expect(pickBackupsToDelete(names([0, 1, 2, 3, 4, 5, 6]))).toEqual([]);
  });

  it('остаются 7 последних, по одной за 4 прошлые недели и последняя копия каждой версии', () => {
    const files = [...names(Array.from({ length: 60 }, (_, i) => i)), ...names([70, 75], '0.5.2')];
    const del = new Set(pickBackupsToDelete(files));
    const kept = files.map((f) => f.name).filter((n) => !del.has(n));
    // 7 последних дней
    for (let i = 0; i < 7; i++) expect(kept).toContain(day(i));
    // последняя копия старой версии пережила ротацию, остальные её копии удалены
    expect(kept).toContain(day(70, '0.5.2'));
    expect(kept).not.toContain(day(75, '0.5.2'));
    // всего: 7 + 4 недельных + 1 копия старой версии
    expect(kept).toHaveLength(7 + 4 + 1);
  });

  it('чужие файлы в папке не удаляются, а копии «до обновления» сохраняются', () => {
    const files = [{ name: 'заметки.txt' }, ...names([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), ...names([20], '0.5.0'), ...names([30], '0.4.0')];
    const del = pickBackupsToDelete(files);
    expect(del).not.toContain('заметки.txt');
    expect(del).not.toContain(day(20, '0.5.0'));
    expect(del).not.toContain(day(30, '0.4.0'));
  });
});

// ---------- автокопия на поддельной платформе ----------
function fakePlatform(version = '0.6.0') {
  const files = new Map<string, { text: string; mtime: number }>();
  const mem = new Map<string, string>();
  const platform = {
    ...createWebPlatform(version),
    info: { native: true, os: 'android', version },
    secureStorage: {
      hardwareBacked: true,
      get: async (k: string) => mem.get(k) ?? null,
      set: async (k: string, v: string) => { mem.set(k, v); },
      remove: async (k: string) => { mem.delete(k); }
    },
    backups: {
      available: true,
      write: vi.fn(async (n: string, t: string) => { files.set(n, { text: t, mtime: Date.now() }); }),
      list: async (): Promise<BackupFile[]> => [...files].map(([name, f]) => ({ name, size: f.text.length, mtime: f.mtime })),
      read: async (n: string) => { const f = files.get(n); if (!f) throw new Error('нет файла'); return f.text; },
      remove: vi.fn(async (n: string) => { files.delete(n); })
    }
  } as unknown as Platform;
  return { platform, files, mem };
}

const workout = (id: string): Omit<Workout, 'updatedAt' | 'deviceId'> =>
  ({ id, date: '2026-10-29', title: 'Грудь', status: 'done', createdAt: 0, exercises: [] }) as never;

beforeEach(async () => {
  await Promise.all([db.workouts.clear(), db.body.clear(), db.tracks.clear(), db.kv.clear(), db.changes.clear(), db.templates.clear()]);
});

describe('автокопия', () => {
  it('в браузере её нет', async () => {
    setPlatform(createWebPlatform('0.6.0'));
    expect(await runAutoBackup({ force: true })).toBe('unavailable');
  });

  it('пустую базу не копирует: иначе пустая копия вытеснит хорошие', async () => {
    const { platform, files } = fakePlatform(); setPlatform(platform);
    expect(await runAutoBackup()).toBe('skipped-empty');
    expect(files.size).toBe(0);
  });

  it('копия шифруется ключом из защищённого хранилища, читается обратно и не чаще раза в сутки', async () => {
    const { platform, files, mem } = fakePlatform(); setPlatform(platform);
    await putWorkout(workout('w1'));
    const t0 = new Date(2026, 9, 30, 9, 0).getTime();
    expect(await runAutoBackup({ now: t0 })).toBe('done');
    expect([...files.keys()]).toEqual(['auto_0.6.0_2026-10-30.rfb']);
    const text = files.get('auto_0.6.0_2026-10-30.rfb')!.text;
    expect(text).not.toContain('Грудь');           // содержимое не читается без ключа
    expect(mem.has('backup.key')).toBe(true);
    expect(await runAutoBackup({ now: t0 + 3600_000 })).toBe('skipped-recent');
    expect(await runAutoBackup({ now: t0 + 21 * 3600_000 })).toBe('done');
    expect(await runAutoBackup({ now: t0 + 22 * 3600_000, force: true })).toBe('done');
  });

  it('выключенная в настройках автокопия не делается, ручная («сейчас») делается', async () => {
    const { platform, files } = fakePlatform(); setPlatform(platform);
    await putWorkout(workout('w1'));
    await saveSettings({ ...(await loadSettings()), autoBackup: false });
    expect(await runAutoBackup()).toBe('skipped-off');
    expect(files.size).toBe(0);
    expect(await runAutoBackup({ force: true })).toBe('done');
  });

  it('старые копии удаляются по правилам ротации', async () => {
    const { platform, files } = fakePlatform(); setPlatform(platform);
    await putWorkout(workout('w1'));
    for (let i = 1; i <= 12; i++) files.set(backupFileName('0.6.0', new Date(2026, 9, 30 - i)), { text: 'x', mtime: 0 });
    await runAutoBackup({ now: new Date(2026, 9, 30, 9).getTime() });
    expect(files.size).toBeLessThanOrEqual(7 + 4);
    expect(files.has('auto_0.6.0_2026-10-30.rfb')).toBe(true);
  });

  it('потеря данных: предлагается восстановление, отказ запоминается, согласие возвращает тренировки', async () => {
    const { platform } = fakePlatform(); setPlatform(platform);
    await putWorkout(workout('w1')); await putWorkout(workout('w2'));
    expect(await findRestoreOffer()).toBeNull();           // данные на месте: предлагать нечего
    await runAutoBackup({ force: true });
    await db.workouts.clear();                              // WebView потерял хранилище
    const offer = await findRestoreOffer();
    expect(offer).toMatchObject({ workouts: 2 });
    await declineRestoreOffer(offer!.name);
    expect(await findRestoreOffer()).toBeNull();

    const [newest] = await listAutoBackups();
    const r = await restoreAutoBackup(newest.name);
    expect(r.workouts).toBe(2);
    expect((await db.workouts.toArray()).map((w) => w.id).sort()).toEqual(['w1', 'w2']);
  });

  it('импорт: обычный файл читается как есть; копия с паролем — по паролю; отмена ввода прерывает', async () => {
    const { platform } = fakePlatform(); setPlatform(platform);
    expect(await openBackupText('{"version":1}', () => null)).toBe('{"version":1}');
    const enc = await encryptBackup('{"version":1,"workouts":[]}', { kind: 'password', pass: 'пароль' }, FAST);
    expect(await openBackupText(enc, () => 'пароль')).toBe('{"version":1,"workouts":[]}');
    await expect(openBackupText(enc, () => 'не тот')).rejects.toThrow(/Неверный пароль/);
    await expect(openBackupText(enc, () => null)).rejects.toThrow(/отменён/);
  });
});
