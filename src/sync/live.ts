// Живая синхронизация: канал «на сервере есть новые изменения» (SSE). Данных он не несёт: услышав сигнал, приложение
// делает обычный обмен. Канал вспомогательный, поэтому любая беда с ним (старый сервер, обрыв, прокси, таймаут)
// переводит в состояние fallback, и синхронизацию продолжает обычный опрос.
// EventSource не умеет заголовки, а авторизация идёт через Authorization, поэтому читаем поток через fetch.

export type LiveState = 'off' | 'connecting' | 'live' | 'fallback';
export interface LiveEvent { seq: number; by: string }

export interface SseMessage { event: string; data: string }

/** Построчный разбор потока SSE: понимает \r\n, комментарии (пинги), несколько data-строк и куски, разорванные где угодно. */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];

  /** Возвращает целые сообщения, накопившиеся к этому моменту. */
  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    let i: number;
    // \r в самом конце может оказаться началом \r\n, который разорван между кусками: ждём следующий кусок
    while ((i = this.buf.search(/\r\n|\n|\r(?!$)/)) >= 0) {
      const m = /\r\n|\n|\r(?!$)/.exec(this.buf)!;
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + m[0].length);
      if (line === '') {
        if (this.data.length || this.event) out.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.event = ''; this.data = [];
      } else if (line.startsWith(':')) {
        continue; // комментарий (пинг): сообщения не образует, но показывает, что канал жив
      } else {
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
      }
    }
    return out;
  }
}

export interface LiveDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  getConfig: () => Promise<{ baseUrl: string; token: string } | null>;
  /** На сервере появились чужие изменения (или канал только что восстановился после обрыва). */
  onChange: (ev: LiveEvent | null) => void;
  onState: (s: LiveState) => void;
}
export interface LiveOptions {
  /** Паузы между попытками подключиться, мс; на последней остаёмся. */
  backoffMs?: number[];
  /** Через сколько тишины (пинг приходит раз в 20 секунд) считаем канал мёртвым. */
  idleMs?: number;
  /** Пауза после ответа «такого канала нет» (старый сервер): не стучимся каждую секунду. */
  unsupportedRetryMs?: number;
}

const DEFAULTS = { backoffMs: [1000, 2000, 5000, 15_000, 30_000, 60_000], idleMs: 50_000, unsupportedRetryMs: 10 * 60_000 };

export class LiveChannel {
  state: LiveState = 'off';
  private active = false;
  private gen = 0;
  private ctl: AbortController | null = null;
  private wake: (() => void) | null = null;
  private everLive = false;
  private readonly o: Required<LiveOptions>;

  constructor(private readonly d: LiveDeps, opts: LiveOptions = {}) { this.o = { ...DEFAULTS, ...opts }; }

  isLive(): boolean { return this.state === 'live'; }
  isRunning(): boolean { return this.active; }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.loop(++this.gen);
  }

  stop(): void {
    this.active = false;
    this.gen++;
    this.ctl?.abort();
    this.wake?.();
    this.set('off');
  }

  private set(s: LiveState): void {
    if (this.state === s) return;
    this.state = s;
    this.d.onState(s);
  }

  private sleep(ms: number, gen: number): Promise<void> {
    return new Promise((res) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); res(); }
      this.wake = () => { if (gen !== this.gen || !this.active) done(); };
    });
  }

  private async loop(gen: number): Promise<void> {
    let attempt = 0;
    while (this.active && gen === this.gen) {
      let retryIn = this.o.backoffMs[Math.min(attempt, this.o.backoffMs.length - 1)];
      this.set('connecting');
      try {
        const cfg = await this.d.getConfig();
        if (!cfg) { this.set('off'); this.active = false; return; }
        const r = await this.connect(cfg, gen);
        if (!(this.active && gen === this.gen)) return;
        if (r === 'unauthorized') { this.set('fallback'); this.active = false; return; } // токен не годится: это покажет обычная синхронизация
        if (r === 'unsupported') { this.set('fallback'); retryIn = this.o.unsupportedRetryMs; attempt = 0; }
        else if (r === 'closed-live') { attempt = 0; retryIn = 300; }   // штатное закрытие по времени: переподключаемся сразу
        else { this.set('fallback'); attempt++; }
      } catch {
        if (!(this.active && gen === this.gen)) return;
        this.set('fallback'); attempt++;
      }
      await this.sleep(retryIn, gen);
    }
  }

  private async connect(cfg: { baseUrl: string; token: string }, gen: number): Promise<'closed-live' | 'dropped' | 'unauthorized' | 'unsupported'> {
    const ctl = new AbortController();
    this.ctl = ctl;
    const res = await this.d.fetch(`${cfg.baseUrl}/api/sync/events`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'text/event-stream' }, signal: ctl.signal, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) return 'unauthorized';
    if (res.status === 404 || res.status === 405 || res.status === 501) return 'unsupported';
    if (!res.ok || !res.body) return res.ok ? 'unsupported' : 'dropped'; // нет потокового чтения: канал недоступен
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const parser = new SseParser();
    let wentLive = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(), this.o.idleMs); };
    arm();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (gen !== this.gen || !this.active) return 'dropped';
        if (done) return wentLive ? 'closed-live' : 'dropped';
        arm();
        for (const m of parser.push(dec.decode(value, { stream: true }))) {
          if (m.event === 'hello') {
            wentLive = true;
            this.set('live');
            if (this.everLive) this.d.onChange(null); // после обрыва могли пропустить изменения: один обмен для догонки
            this.everLive = true;
          } else if (m.event === 'seq') {
            try { const ev = JSON.parse(m.data) as LiveEvent; if (typeof ev.seq === 'number') this.d.onChange(ev); } catch { /* битое событие: опрос подстрахует */ }
          } else if (m.event === 'bye') {
            return 'closed-live';
          }
        }
      }
    } catch (e) {
      if (!(this.active && gen === this.gen)) return 'dropped';
      throw e;
    } finally {
      clearTimeout(idle);
      ctl.abort();
      reader.cancel().catch(() => undefined);
    }
  }
}

// ---------- когда опрашивать ----------
export const POLL_MS = 30_000;
/** Пока канал жив, опрос остаётся страховкой: раз в LIVE_POLL_EVERY тиков (5 минут), а не каждый. */
export const LIVE_POLL_EVERY = 10;

/** Нужен ли опрос на этом тике (тики идут раз в POLL_MS). Без живого канала опрашиваем каждый тик. */
export function shouldPoll(state: LiveState, tick: number): boolean {
  return state !== 'live' || tick % LIVE_POLL_EVERY === 0;
}
