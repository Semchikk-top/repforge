import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/db';
import { setPlatform } from '../../src/platform';
import { createWebPlatform } from '../../src/platform/web';
import type { Platform, SecureStorageApi } from '../../src/platform/types';
import { apiFetch, getServerUrl, initSyncStatus, getSyncStatus, pairWithCode, unpair } from '../../src/sync/sync';

function secure(hardwareBacked: boolean) {
  const mem = new Map<string, string>();
  const api: SecureStorageApi = {
    hardwareBacked,
    get: vi.fn(async (k) => mem.get(k) ?? null),
    set: vi.fn(async (k, v) => { mem.set(k, v); }),
    remove: vi.fn(async (k) => { mem.delete(k); })
  };
  return { api, mem };
}
const use = (s: SecureStorageApi) => setPlatform({ ...createWebPlatform('t'), secureStorage: s } as Platform);

const calls: Array<{ url: string; auth?: string }> = [];
beforeEach(async () => {
  calls.length = 0;
  await Promise.all([db.kv.clear(), db.changes.clear()]);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (url.endsWith('/api/pair')) return { ok: true, status: 200, json: async () => ({ token: 'TOKEN-1' }) } as Response;
    if (url.endsWith('/api/sync')) return { ok: true, status: 200, json: async () => ({ seq: 1, more: false, entities: [] }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); setPlatform(createWebPlatform('t')); });

describe('токен устройства в защищённом хранилище', () => {
  it('после сопряжения токен лежит в хранилище, а в IndexedDB остался только адрес', async () => {
    const s = secure(true); use(s.api);
    await pairWithCode('ABCD-1234', 'https://pc.ts.net');
    expect(s.mem.get('sync.token')).toBe('TOKEN-1');
    expect((await db.kv.get('sync.config'))?.value).toEqual({ token: '', baseUrl: 'https://pc.ts.net' });
    expect(calls.find((c) => c.url.endsWith('/api/sync'))?.auth).toBe('Bearer TOKEN-1');
    expect(await getServerUrl()).toBe('https://pc.ts.net');
  });

  it('токен из старой установки переносится и стирается из IndexedDB', async () => {
    const s = secure(true); use(s.api);
    await db.kv.put({ key: 'sync.config', value: { token: 'LEGACY', baseUrl: 'https://pc.ts.net' } });
    await apiFetch('/api/ping');
    expect(calls.at(-1)).toMatchObject({ url: 'https://pc.ts.net/api/ping', auth: 'Bearer LEGACY' });
    expect(s.mem.get('sync.token')).toBe('LEGACY');
    expect((await db.kv.get('sync.config'))?.value).toEqual({ token: '', baseUrl: 'https://pc.ts.net' });
    await apiFetch('/api/ping'); // дальше токен берётся уже из хранилища
    expect(calls.at(-1)?.auth).toBe('Bearer LEGACY');
  });

  it('если хранилище отказало, токен не теряется: остаётся в IndexedDB как раньше', async () => {
    const s = secure(true);
    s.api.set = vi.fn(async () => { throw new Error('keystore unavailable'); });
    use(s.api);
    await pairWithCode('ABCD-1234', 'https://pc.ts.net');
    expect((await db.kv.get('sync.config'))?.value).toEqual({ token: 'TOKEN-1', baseUrl: 'https://pc.ts.net' });
    await apiFetch('/api/ping');
    expect(calls.at(-1)?.auth).toBe('Bearer TOKEN-1');
  });

  it('токена в хранилище нет (система сбросила ключ): устройство считается не подключённым, адрес сервера помнится', async () => {
    const s = secure(true); use(s.api);
    await db.kv.put({ key: 'sync.config', value: { token: '', baseUrl: 'https://pc.ts.net' } });
    await initSyncStatus();
    expect(getSyncStatus().configured).toBe(false);
    expect(await getServerUrl()).toBe('https://pc.ts.net');
    await expect(apiFetch('/api/ping')).rejects.toThrow(/не подключено/);
  });

  it('отключение стирает токен из хранилища', async () => {
    const s = secure(true); use(s.api);
    await pairWithCode('ABCD-1234', 'https://pc.ts.net');
    await unpair();
    expect(s.mem.has('sync.token')).toBe(false);
    expect(await db.kv.get('sync.config')).toBeUndefined();
  });

  it('в браузере всё как раньше: хранилище не трогается', async () => {
    const s = secure(false); use(s.api);
    await pairWithCode('ABCD-1234');
    expect(s.api.set).not.toHaveBeenCalled();
    expect((await db.kv.get('sync.config'))?.value).toEqual({ token: 'TOKEN-1', baseUrl: '' });
    await apiFetch('/api/ping');
    expect(calls.at(-1)?.auth).toBe('Bearer TOKEN-1');
  });
});
