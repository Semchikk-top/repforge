// Версии протокола, расхождение часов и журнал событий синхронизации (0.11).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/db';
import { setPlatform } from '../../src/platform';
import { createWebPlatform } from '../../src/platform/web';
import { parseSyncFailure, PROTOCOL_VERSION } from '../../src/sync/protocol';
import { clockMessage, clockProblem, formatSkew, measureClock } from '../../src/sync/clock';
import { _resetSyncLogCache, logSyncEvent, readSyncEvents } from '../../src/sync/log';
import { getSyncStatus, initSyncStatus, syncNow } from '../../src/sync/sync';

describe('разбор отказа сервера', () => {
  it('426 server_outdated и client_outdated различаются', () => {
    expect(parseSyncFailure(426, { detail: { code: 'server_outdated' } })).toMatchObject({ incompat: 'server_outdated' });
    expect(parseSyncFailure(426, { detail: { code: 'client_outdated' } })).toMatchObject({ incompat: 'client_outdated' });
  });
  it('старый сервер, не знающий таблицы, распознаётся как «сервер устарел»', () => {
    const f = parseSyncFailure(422, { detail: 'Неизвестная таблица: game' });
    expect(f.incompat).toBe('server_outdated');
    expect(f.message).toMatch(/обнови сервер/i);
  });
  it('прочие ошибки несовместимостью не считаются', () => {
    expect(parseSyncFailure(500, null)).toEqual({ incompat: null, message: 'Ошибка сервера (500)' });
    expect(parseSyncFailure(422, { detail: 'другое' }).incompat).toBeNull();
    expect(parseSyncFailure(426, { detail: { code: 'что-то новое', message: 'Текст' } })).toEqual({ incompat: null, message: 'Текст' });
  });
});

describe('часы', () => {
  it('смещение считается от середины запроса', () => {
    // отправили в 1000, получили в 1200 → середина 1100; сервер говорит 61100 → сервер впереди на минуту
    expect(measureClock(1000, 1200, 61_100)).toEqual({ offsetMs: 60_000, rttMs: 200, at: 1200 });
  });
  it('мусор и слишком медленные запросы не измеряются', () => {
    expect(measureClock(1000, 900, 5000)).toBeNull();
    expect(measureClock(0, 40_000, 1_000_000)).toBeNull();
    expect(measureClock(0, 10, NaN)).toBeNull();
    expect(measureClock(0, 10, 0)).toBeNull();
  });
  it('до двух минут не предупреждаем, больше — предупреждаем, направление верное', () => {
    expect(clockProblem({ offsetMs: 90_000, rttMs: 100, at: 1 })).toBeNull();
    expect(clockProblem(null)).toBeNull();
    expect(clockProblem({ offsetMs: -5 * 60_000, rttMs: 100, at: 1 })).toMatchObject({ ahead: true });
    expect(clockProblem({ offsetMs: 5 * 60_000, rttMs: 100, at: 1 })).toMatchObject({ ahead: false });
  });
  it('при очень долгом запросе порог поднимается до задержки', () => {
    expect(clockProblem({ offsetMs: 3 * 60_000, rttMs: 25_000, at: 1 })).toMatchObject({ ahead: false });
    expect(clockProblem({ offsetMs: 25_000, rttMs: 25_000, at: 1 })).toBeNull();
  });
  it('формат длительности и сообщение', () => {
    expect(formatSkew(-5 * 60_000)).toBe('5 мин');
    expect(formatSkew(3 * 3600_000 + 10 * 60_000)).toBe('3 ч 10 мин');
    expect(formatSkew(5 * 24 * 3600_000)).toBe('5 дн.');
    expect(clockMessage({ ahead: true, offsetMs: -300_000 })).toMatch(/спешат.*5 мин/);
    expect(clockMessage({ ahead: false, offsetMs: 300_000 })).toMatch(/отстают/);
  });
});

describe('журнал событий', () => {
  beforeEach(async () => { await db.kv.clear(); _resetSyncLogCache(); });
  it('склеивает подряд одинаковые, хранит не больше 40 и вычищает токены', async () => {
    await logSyncEvent('error', 'Нет связи', 1);
    await logSyncEvent('error', 'Нет связи', 2);
    await logSyncEvent('warn', 'Authorization: Bearer abc123 token=zzz', 3);
    const ev = await readSyncEvents();
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ msg: 'Нет связи', count: 2, at: 2 });
    expect(JSON.stringify(ev)).not.toMatch(/abc123|zzz/);
    for (let i = 0; i < 60; i++) await logSyncEvent('info', `событие ${i}`, 10 + i);
    expect((await readSyncEvents()).length).toBe(40);
  });
  it('переживает перезапуск (читается из хранилища)', async () => {
    await logSyncEvent('error', 'сбой', 5);
    _resetSyncLogCache();
    expect((await readSyncEvents())[0].msg).toBe('сбой');
  });
});

describe('синхронизация с сервером разных версий', () => {
  let responder: (url: string, init?: RequestInit) => Promise<Partial<Response>>;
  let sentBodies: Array<Record<string, unknown>>;
  beforeEach(async () => {
    sentBodies = [];
    await Promise.all([db.kv.clear(), db.changes.clear()]);
    _resetSyncLogCache();
    await db.kv.put({ key: 'sync.config', value: { token: 'T', baseUrl: '' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/sync')) sentBodies.push(JSON.parse(String(init?.body)));
      return responder(url, init) as Promise<Response>;
    }));
    await initSyncStatus();
  });
  afterEach(() => { vi.unstubAllGlobals(); setPlatform(createWebPlatform('t')); });

  it('запрос несёт версию протокола, ответ сохраняет версии сервера и часы', async () => {
    responder = async () => ({ ok: true, status: 200, json: async () => ({ seq: 1, more: false, entities: [], protocol: 1, minClientProtocol: 1, schema: 1, serverTime: Date.now() + 10 * 60_000 }) });
    await syncNow();
    expect(sentBodies[0].protocol).toBe(PROTOCOL_VERSION);
    const st = getSyncStatus();
    expect(st.server).toEqual({ protocol: 1, minClientProtocol: 1, schema: 1 });
    expect(st.error).toBeNull();
    expect(clockProblem(st.clock)).toMatchObject({ ahead: false });
    expect((await db.kv.get('sync.clock'))?.value).toMatchObject({ offsetMs: expect.any(Number) });
    expect((await readSyncEvents()).some((e) => e.kind === 'warn' && /отстают/.test(e.msg))).toBe(true);
  });

  it('сервер без версий в ответе (до 0.11) работает как раньше', async () => {
    responder = async () => ({ ok: true, status: 200, json: async () => ({ seq: 1, more: false, entities: [] }) });
    await syncNow();
    expect(getSyncStatus()).toMatchObject({ error: null, server: null, clock: null, incompat: null });
  });

  it('старый сервер отвечает 422 про таблицу: понятная ошибка, а не «Ошибка сервера (422)»', async () => {
    responder = async () => ({ ok: false, status: 422, json: async () => ({ detail: 'Неизвестная таблица: checkins' }) });
    await syncNow();
    expect(getSyncStatus()).toMatchObject({ incompat: 'server_outdated' });
    expect(getSyncStatus().error).toMatch(/обнови сервер/i);
    expect((await readSyncEvents())[0]).toMatchObject({ kind: 'error' });
  });

  it('после обновления сервера несовместимость снимается', async () => {
    responder = async () => ({ ok: false, status: 426, json: async () => ({ detail: { code: 'server_outdated', message: 'x' } }) });
    await syncNow();
    expect(getSyncStatus().incompat).toBe('server_outdated');
    responder = async () => ({ ok: true, status: 200, json: async () => ({ seq: 1, more: false, entities: [], protocol: 1 }) });
    await syncNow();
    expect(getSyncStatus()).toMatchObject({ incompat: null, error: null });
  });
});
