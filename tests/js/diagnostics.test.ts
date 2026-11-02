// Диагностика (0.11): доступ только по достижению «Разработчик», отчёт без секретов.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/db';
import { buildReport, collectDiagnostics, compatibilityLine, diagnosticsUnlocked } from '../../src/sync/diagnostics';
import { PROTOCOL_VERSION } from '../../src/sync/protocol';
import { _resetSyncLogCache, logSyncEvent } from '../../src/sync/log';
import { totalsOf } from '../../src/game/ledger';
import { ACH_BY_ID } from '../../src/game/achievements';

describe('доступ', () => {
  it('достижение «Разработчик» существует, ручное и выдаётся нажатиями на версию', () => {
    expect(ACH_BY_ID.get('dev')?.manual).toBe(true);
  });
  it('экран закрыт, пока достижения нет, и открывается после него', () => {
    expect(diagnosticsUnlocked(new Map())).toBe(false);
    expect(diagnosticsUnlocked(new Map([['w10', 1]]))).toBe(false);
    const rows = [{ id: 'ach:dev', kind: 'achievement', achId: 'dev', xp: 500, coins: 500, at: 5, createdAt: 5, updatedAt: 5, deviceId: 'd' }] as never;
    expect(diagnosticsUnlocked(totalsOf(rows).unlocked)).toBe(true);
  });
});

describe('сбор и отчёт', () => {
  beforeEach(async () => {
    await Promise.all([db.kv.clear(), db.changes.clear(), db.conflicts.clear(), db.workouts.clear()]);
    _resetSyncLogCache();
  });

  it('без подключения: версии и счётчики есть, сервера нет', async () => {
    await db.kv.put({ key: 'deviceId', value: 'abcdef1234567890SECRET' });
    await db.changes.add({ table: 'workouts', entityId: 'w1', op: 'put', ts: 1, deviceId: 'd', synced: 0 });
    const d = await collectDiagnostics();
    expect(d.app.protocol).toBe(PROTOCOL_VERSION);
    expect(d.app.dbVersion).toBeGreaterThanOrEqual(8);
    expect(d.serverInfo).toBeNull();
    expect(d.sync.pending).toBe(1);
    expect(d.deviceId).toBe('abcdef12');
    expect(compatibilityLine(d)).toBe('Устройство не подключено');
  });

  it('в отчёте нет токена, полного id устройства и адреса сервера', async () => {
    await db.kv.put({ key: 'deviceId', value: 'abcdef1234567890SECRET' });
    await db.kv.put({ key: 'sync.config', value: { token: 'TOP-SECRET-TOKEN', baseUrl: 'https://pc.my-tailnet.ts.net' } });
    await logSyncEvent('error', 'Ошибка сервера (500) Authorization: Bearer TOP-SECRET-TOKEN');
    const text = buildReport(await collectDiagnostics());
    expect(text).toContain('Диагностика RepForge');
    expect(text).toContain(`протокол ${PROTOCOL_VERSION}`);
    expect(text).not.toMatch(/TOP-SECRET|SECRET|my-tailnet/);
    expect(text).toContain('Ошибка сервера (500)');
  });

  it('сервер без поддержки диагностики и недоступный сервер различаются', async () => {
    await db.kv.put({ key: 'sync.config', value: { token: 'T', baseUrl: '' } });
    const { initSyncStatus } = await import('../../src/sync/sync');
    await initSyncStatus();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect((await collectDiagnostics()).serverInfo).toBe('unsupported');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect((await collectDiagnostics()).serverInfo).toBe('unreachable');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ serverVersion: '0.11.0', protocol: 1, minClientProtocol: 1, schema: 1, python: '3.12', seq: 4, time: 1, entities: { workouts: 2 }, deletedEntities: 0, devices: 2, dbBytes: 2048, backups: 3 }) })));
    const d = await collectDiagnostics();
    expect(typeof d.serverInfo).toBe('object');
    expect(buildReport(d)).toMatch(/версия 0\.11\.0, протокол 1/);
    vi.unstubAllGlobals();
  });
});
