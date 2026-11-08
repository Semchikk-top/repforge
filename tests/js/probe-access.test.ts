// Отозванное устройство узнаёт, что его вернули: проверка доступа после 401.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/db';
import { setPlatform } from '../../src/platform';
import { createWebPlatform } from '../../src/platform/web';
import { getSyncStatus, initSyncStatus, probeAccess, syncNow, unpair } from '../../src/sync/sync';

const ok = () => new Response(JSON.stringify({ seq: 1, more: false, entities: [], protocol: 1, minClientProtocol: 1, schema: 1, serverTime: Date.now(), accepted: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
const denied = () => new Response('{"detail":"no"}', { status: 401 });

let revoked = true;
let syncCalls = 0;
beforeEach(async () => {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  setPlatform(createWebPlatform());
  await db.kv.clear();
  await db.kv.put({ key: 'sync.config', value: { token: 'T', baseUrl: 'https://pc.example' } });
  revoked = true; syncCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/sync')) { syncCalls++; return revoked ? denied() : ok(); }
    return new Response('nf', { status: 404 }); // канал SSE и прочее: не нужны
  }));
  await initSyncStatus();
});
afterEach(async () => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); await unpair().catch(() => undefined); vi.unstubAllGlobals(); });

describe('probeAccess', () => {
  it('отозванное устройство получает 401 и считается отключённым', async () => {
    await syncNow();
    expect(getSyncStatus().unauthorized).toBe(true);
  });

  it('после восстановления на сервере проверка возвращает доступ без повторного ввода кода', async () => {
    await syncNow();
    revoked = false;
    expect(await probeAccess(true)).toBe(true);
    const st = getSyncStatus();
    expect(st.unauthorized).toBe(false);
    expect(st.error).toBeNull();
    expect(st.lastAt).not.toBeNull();
  });

  it('пока устройство всё ещё отозвано: остаётся отключённым, ложного «подключено» нет', async () => {
    await syncNow();
    expect(await probeAccess(true)).toBe(false);
    expect(getSyncStatus().unauthorized).toBe(true);
    expect(getSyncStatus().error).toMatch(/отключено/i);
  });

  it('автоматические проверки редкие: вторая подряд без force не делает запрос', async () => {
    await syncNow();
    const before = syncCalls;
    await probeAccess(true);                    // явная проверка запоминает время
    const afterForced = syncCalls;
    expect(afterForced).toBe(before + 1);
    expect(await probeAccess()).toBe(false);    // автоматическая сразу после неё пропускается
    expect(syncCalls).toBe(afterForced);
  });

  it('не отключённое устройство и не подключённое к серверу не проверяются', async () => {
    revoked = false;
    await syncNow();
    const n = syncCalls;
    expect(await probeAccess(true)).toBe(false);
    expect(syncCalls).toBe(n);
    await unpair();
    expect(await probeAccess(true)).toBe(false);
  });
});
