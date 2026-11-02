import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, parsePairLink } from '../../src/sync/server-url';

describe('normalizeServerUrl', () => {
  it('приводит ввод к origin без пути и слеша', () => {
    expect(normalizeServerUrl('pc.tailnet.ts.net')).toBe('https://pc.tailnet.ts.net');
    expect(normalizeServerUrl('  https://pc.ts.net:8443/ ')).toBe('https://pc.ts.net:8443');
    expect(normalizeServerUrl('https://pc.ts.net/api/pair?x=1#y')).toBe('https://pc.ts.net');
  });

  it('http — только когда разрешено явно (отладочная сборка)', () => {
    expect(() => normalizeServerUrl('http://192.168.1.5:8000', false)).toThrow(/https/);
    expect(normalizeServerUrl('http://192.168.1.5:8000/', true)).toBe('http://192.168.1.5:8000');
  });

  it.each(['', '   ', 'ftp://pc.ts.net', 'javascript:alert(1)', 'https://user:pw@pc.ts.net', 'https://', 'file:///etc/passwd'])('отклоняет %j', (bad) => {
    expect(() => normalizeServerUrl(bad, true)).toThrow();
  });
});

describe('parsePairLink', () => {
  it('workout://pair?url=…&code=…', () => {
    expect(parsePairLink('workout://pair?url=https%3A%2F%2Fpc.ts.net&code=ABCD-1234')).toEqual({ baseUrl: 'https://pc.ts.net', code: 'ABCD-1234' });
    expect(parsePairLink('workout://pair?url=pc.ts.net:8443&code=ABCD1234')).toEqual({ baseUrl: 'https://pc.ts.net:8443', code: 'ABCD1234' });
  });

  it('ссылка из QR для браузера: адрес берётся из неё самой', () => {
    expect(parsePairLink('https://pc.ts.net/#/pair/ABCD-1234')).toEqual({ baseUrl: 'https://pc.ts.net', code: 'ABCD-1234' });
    expect(parsePairLink('http://192.168.1.5:8000/#/pair/ABCD-1234', true)).toEqual({ baseUrl: 'http://192.168.1.5:8000', code: 'ABCD-1234' });
  });

  it('чужие и неполные ссылки — null, а недопустимый адрес — ошибка', () => {
    expect(parsePairLink('workout://settings')).toBeNull();
    expect(parsePairLink('workout://pair?code=ABCD-1234')).toBeNull();
    expect(parsePairLink('workout://pair?url=https%3A%2F%2Fpc.ts.net')).toBeNull();
    expect(parsePairLink('workout://pair?url=https%3A%2F%2Fpc.ts.net&code=%3Cscript%3E')).toBeNull();
    expect(parsePairLink('https://pc.ts.net/#/records')).toBeNull();
    expect(parsePairLink('просто текст')).toBeNull();
    expect(() => parsePairLink('workout://pair?url=http%3A%2F%2F192.168.1.5&code=ABCD-1234', false)).toThrow(/https/);
    expect(() => parsePairLink('workout://pair?url=ftp%3A%2F%2Fx&code=ABCD-1234')).toThrow();
  });
});

import { afterEach, beforeEach, vi } from 'vitest';
import { buildRelayUrl, getRelayUrl, relayConfigured, setRelayUrl } from '../../src/nearby/config';

describe('адрес релея, заданный в приложении', () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('без сборочного адреса и без ввода релея нет; ввод включает комнату сразу, без перезапуска', () => {
    expect(buildRelayUrl()).toBe('');
    expect(relayConfigured()).toBe(false);
    expect(setRelayUrl('relay.pc.ts.net/')).toBe('wss://relay.pc.ts.net');
    expect(getRelayUrl()).toBe('wss://relay.pc.ts.net');
    expect(relayConfigured()).toBe(true);
  });

  it('пустой ввод сбрасывает адрес', () => {
    setRelayUrl('wss://relay.example:8443');
    expect(getRelayUrl()).toBe('wss://relay.example:8443');
    expect(setRelayUrl('  ')).toBe('');
    expect(relayConfigured()).toBe(false);
  });

  it('открытый ws:// разрешён только в отладочной сборке; чужие схемы и мусор отклоняются', () => {
    expect(() => setRelayUrl('ws://192.168.1.5:8787', false)).toThrow(/wss/);
    expect(setRelayUrl('ws://192.168.1.5:8787', true)).toBe('ws://192.168.1.5:8787');
    for (const bad of ['https://relay.example', 'ftp://x', 'javascript:alert(1)', 'wss://']) expect(() => setRelayUrl(bad, true)).toThrow();
    expect(getRelayUrl()).toBe('ws://192.168.1.5:8787'); // неудачный ввод прежний адрес не портит
  });

  it('недоступное хранилище не ломает чтение адреса', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    expect(getRelayUrl()).toBe('');
  });
});
