// Движок синхронизации и канал SSE вместе: канал включается по состоянию подключения и откатывается на опрос.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/db';
import { setPlatform } from '../../src/platform';
import { createWebPlatform } from '../../src/platform/web';
import { getSyncStatus, initSyncStatus, syncLive, unpair } from '../../src/sync/sync';

const enc = new TextEncoder();
function sseResponse(init: RequestInit, first: string) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; ctl.enqueue(enc.encode(first)); } });
  init.signal?.addEventListener('abort', () => { try { ctl.error(new Error('aborted')); } catch { /* закрыт */ } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  setPlatform(createWebPlatform());
  await db.kv.clear();
});
afterEach(async () => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); await unpair().catch(() => undefined); vi.unstubAllGlobals(); });

describe('канал в движке синхронизации', () => {
  it('не подключён к серверу: канал выключен и сеть не трогается', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    await initSyncStatus();
    syncLive();
    await tick();
    expect(getSyncStatus().live).toBe('off');
    expect(f).not.toHaveBeenCalled();
  });

  it('подключённое устройство: канал поднимается, статус live; отзыв токена (401) откатывает на опрос', async () => {
    await db.kv.put({ key: 'sync.config', value: { token: 'T', baseUrl: 'https://pc.example' } });
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push(url);
      return url.endsWith('/api/sync/events') ? sseResponse(init, 'event: hello\ndata: {"seq":1}\n\n') : new Response('{}', { status: 401 });
    }));
    await initSyncStatus();
    await tick(80);
    expect(seen.some((u) => u.endsWith('/api/sync/events'))).toBe(true);
    expect(getSyncStatus().live).toBe('live');
    await unpair();
    await tick();
    expect(getSyncStatus().live).toBe('off');
  });

  it('старый сервер без канала (404): статус fallback, обычная синхронизация не страдает', async () => {
    await db.kv.put({ key: 'sync.config', value: { token: 'T', baseUrl: 'https://pc.example' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/api/sync/events') ? new Response('nf', { status: 404 }) : new Response('{}', { status: 500 }))));
    await initSyncStatus();
    await tick(80);
    expect(getSyncStatus().live).toBe('fallback');
  });
});
