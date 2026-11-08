import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveChannel, SseParser, type LiveEvent, type LiveState } from '../../src/sync/live';

describe('SseParser', () => {
  it('собирает сообщение из кусков, разорванных где угодно', () => {
    const p = new SseParser();
    expect(p.push('event: se')).toEqual([]);
    expect(p.push('q\ndata: {"seq":')).toEqual([]);
    expect(p.push('5}\n\n')).toEqual([{ event: 'seq', data: '{"seq":5}' }]);
  });
  it('понимает \\r\\n, комментарии-пинги, retry и несколько сообщений в одном куске', () => {
    const p = new SseParser();
    const out = p.push('retry: 5000\r\nevent: hello\r\ndata: {}\r\n\r\n: ping\n\nevent: seq\ndata: 1\n\n');
    expect(out).toEqual([{ event: 'hello', data: '{}' }, { event: 'seq', data: '1' }]);
  });
  it('несколько data-строк склеиваются через перевод строки; без event — message', () => {
    expect(new SseParser().push('data: a\ndata: b\n\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
  it('пустые блоки и одни комментарии сообщений не дают', () => {
    expect(new SseParser().push(': ping\n\n\n\n')).toEqual([]);
  });
});

// ---------- канал ----------
const enc = new TextEncoder();

/** Управляемый поток: test.send('…') отдаёт куски, test.end() закрывает его. */
function stream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  return {
    body,
    send: (s: string) => ctl.enqueue(enc.encode(s)),
    end: () => { try { ctl.close(); } catch { /* уже закрыт */ } },
    fail: () => { try { ctl.error(new Error('network')); } catch { /* уже закрыт */ } }
  };
}
type S = ReturnType<typeof stream>;
// как настоящий fetch: отмена запроса обрывает чтение тела
const ok = (s: S, init?: RequestInit) => {
  init?.signal?.addEventListener('abort', () => s.fail());
  return new Response(s.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const HELLO = 'retry: 5000\nevent: hello\ndata: {"seq":3}\n\n';
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function setup(responses: Array<(init: RequestInit) => Response | Promise<Response>>, opts = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const states: LiveState[] = [];
  const changes: Array<LiveEvent | null> = [];
  let i = 0;
  const ch = new LiveChannel({
    fetch: async (url, init) => {
      calls.push({ url, init });
      const f = responses[Math.min(i++, responses.length - 1)];
      return f(init);
    },
    getConfig: async () => ({ baseUrl: 'https://pc.example', token: 'TOKEN' }),
    onChange: (e) => changes.push(e),
    onState: (s) => states.push(s)
  }, { backoffMs: [10, 20], idleMs: 80, unsupportedRetryMs: 5000, ...opts });
  return { ch, calls, states, changes };
}

const channels: LiveChannel[] = [];
afterEach(() => { channels.splice(0).forEach((c) => c.stop()); });
const track = <T extends { ch: LiveChannel }>(x: T): T => { channels.push(x.ch); return x; };

describe('LiveChannel', () => {
  it('подключается с токеном, после hello — live, чужое изменение вызывает обмен', async () => {
    const s = stream();
    const t = track(setup([(i) => ok(s, i)]));
    t.ch.start();
    await tick();
    expect(t.calls[0].url).toBe('https://pc.example/api/sync/events');
    expect((t.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN');
    expect(t.ch.isLive()).toBe(false);
    s.send(HELLO);
    await tick();
    expect(t.ch.isLive()).toBe(true);
    expect(t.changes).toEqual([]);              // первое hello обмена не требует: старт синхронизации уже запланирован
    s.send(': ping\n\nevent: seq\ndata: {"seq":4,"by":"dev-b"}\n\n');
    await tick();
    expect(t.changes).toEqual([{ seq: 4, by: 'dev-b' }]);
    expect(t.states).toEqual(['connecting', 'live']);
  });

  it('обрыв потока: fallback, переподключение и один догоняющий обмен после нового hello', async () => {
    const a = stream(), b = stream();
    const t = track(setup([(i) => ok(a, i), (i) => ok(b, i)]));
    t.ch.start();
    await tick(); a.send(HELLO); await tick();
    a.fail();                                    // сеть пропала посреди потока
    await tick(40);
    expect(t.states).toContain('fallback');
    expect(t.calls.length).toBe(2);              // повторное подключение
    b.send(HELLO); await tick();
    expect(t.ch.isLive()).toBe(true);
    expect(t.changes).toEqual([null]);           // null: «проверь, не пропустил ли изменения»
  });

  it('штатное закрытие по времени (bye): переподключается быстро, без fallback-обмена', async () => {
    const a = stream(), b = stream();
    const t = track(setup([(i) => ok(a, i), (i) => ok(b, i)], { idleMs: 5000 }));
    t.ch.start();
    await tick(); a.send(HELLO); await tick();
    a.send('event: bye\ndata: {}\n\n'); a.end();
    await tick(450);
    expect(t.calls.length).toBe(2);
    expect(t.states).not.toContain('fallback');
  });

  it('сервер без канала (404): fallback и долгая пауза, а не частые запросы', async () => {
    const t = track(setup([() => new Response('no', { status: 404 })]));
    t.ch.start();
    await tick(120);
    expect(t.ch.state).toBe('fallback');
    expect(t.calls.length).toBe(1);
  });

  it('401: fallback и больше не пытается (токен проверит обычная синхронизация)', async () => {
    const t = track(setup([() => new Response('x', { status: 401 })]));
    t.ch.start();
    await tick(120);
    expect(t.ch.state).toBe('fallback');
    expect(t.calls.length).toBe(1);
    expect(t.ch.isRunning()).toBe(false);
  });

  it('сетевые ошибки и 5xx: повторы с нарастающей паузой, затем успех', async () => {
    const s = stream();
    const t = track(setup([() => { throw new TypeError('Failed to fetch'); }, () => new Response('', { status: 503 }), (i) => ok(s, i)], { idleMs: 5000 }));
    t.ch.start();
    await tick(10);
    s.send(HELLO);
    await tick(120);
    expect(t.calls.length).toBe(3);
    expect(t.ch.isLive()).toBe(true);
    expect(t.states).toContain('fallback');
  });

  it('тишина дольше порога (нет даже пингов): канал считается мёртвым и переподключается', async () => {
    const a = stream(), b = stream();
    const t = track(setup([(i) => ok(a, i), (i) => ok(b, i)]));
    t.ch.start();
    await tick(); a.send(HELLO); await tick();
    await tick(200);                              // idleMs = 80
    expect(t.calls.length).toBeGreaterThanOrEqual(2);
    expect(t.states).toContain('fallback');
  });

  it('пинги удерживают канал живым дольше порога тишины', async () => {
    const a = stream();
    const t = track(setup([(i) => ok(a, i)]));
    t.ch.start();
    await tick(); a.send(HELLO);
    for (let i = 0; i < 5; i++) { await tick(40); a.send(': ping\n\n'); }
    expect(t.ch.isLive()).toBe(true);
    expect(t.calls.length).toBe(1);
  });

  it('stop(): обрывает запрос, состояние off, новых подключений нет', async () => {
    const s = stream(), s2 = stream();
    let signal: AbortSignal | null | undefined;
    const t = track(setup([(init) => { signal = init.signal; return ok(s, init); }, (i) => ok(s2, i)]));
    t.ch.start();
    await tick(); s.send(HELLO); await tick();
    t.ch.stop();
    await tick(60);
    expect(signal?.aborted).toBe(true);
    expect(t.ch.state).toBe('off');
    expect(t.calls.length).toBe(1);
    t.ch.start();                                 // повторный запуск после остановки работает
    await tick();
    expect(t.calls.length).toBe(2);
  });

  it('нет настроенного сервера: канал не запускается', async () => {
    const states: LiveState[] = [];
    const ch = new LiveChannel({ fetch: vi.fn(), getConfig: async () => null, onChange: () => undefined, onState: (s) => states.push(s) });
    ch.start();
    await tick();
    expect(ch.state).toBe('off');
    expect(ch.isRunning()).toBe(false);
  });

  it('битое событие игнорируется и канал продолжает работать', async () => {
    const s = stream();
    const t = track(setup([(i) => ok(s, i)]));
    t.ch.start();
    await tick(); s.send(HELLO + 'event: seq\ndata: не json\n\nevent: seq\ndata: {"seq":9,"by":"x"}\n\n');
    await tick();
    expect(t.changes).toEqual([{ seq: 9, by: 'x' }]);
    expect(t.ch.isLive()).toBe(true);
  });
});

import { LIVE_POLL_EVERY, shouldPoll } from '../../src/sync/live';

describe('shouldPoll: опрос как страховка', () => {
  it('без живого канала опрашиваем каждый тик (раз в 30 секунд)', () => {
    for (const st of ['off', 'connecting', 'fallback'] as const) for (let t = 1; t <= 12; t++) expect(shouldPoll(st, t)).toBe(true);
  });
  it('при живом канале опрос редкий: раз в LIVE_POLL_EVERY тиков', () => {
    const polled = Array.from({ length: LIVE_POLL_EVERY * 2 }, (_, i) => i + 1).filter((t) => shouldPoll('live', t));
    expect(polled).toEqual([LIVE_POLL_EVERY, LIVE_POLL_EVERY * 2]);
  });
});
