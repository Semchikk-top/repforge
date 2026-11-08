// Очередь озвучки с приоритетами. Навигация важнее тренировочных подсказок:
//  - навигационную фразу не обрывает и не вытесняет тренировочная;
//  - навигация, пришедшая во время тренировочной фразы, прерывает её и идёт следующей;
//  - устаревшие тренировочные фразы выбрасываются, а не произносятся с опозданием;
//  - сбой озвучки никогда не доходит до тренировки.
// Чистая логика: движок и часы передаются снаружи.

export type SpeechPriority = 'nav' | 'training';
export interface SpeechMessage {
  text: string;
  priority: SpeechPriority;
  /** Одинаковый ключ в очереди или в эфире второй раз не принимается (защита от повторов). */
  key?: string;
  /** Через сколько мс после постановки фраза считается устаревшей. */
  ttlMs?: number;
}
export interface SpeechEngine { speak(text: string): Promise<void>; stop(): Promise<void> }
export interface QueueClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export const DEFAULT_TTL_MS: Record<SpeechPriority, number> = { nav: 20_000, training: 10_000 };
const MAX_QUEUED: Record<SpeechPriority, number> = { nav: 4, training: 2 };
export const MAX_SPEAK_MS = 30_000;

const realClock: QueueClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

interface Item { msg: SpeechMessage; expiresAt: number }

export class SpeechQueue {
  private queue: Item[] = [];
  private current: Item | null = null;
  private running = false;
  private enabled = true;
  private waiters: (() => void)[] = [];
  /** Сколько фраз выброшено как устаревшие или вытесненные (для тестов и диагностики). */
  dropped = 0;

  constructor(private engine: SpeechEngine, private clock: QueueClock = realClock) {}

  get pending(): number { return this.queue.length; }
  get speaking(): SpeechMessage | null { return this.current?.msg ?? null; }

  /** Принять фразу. false — отклонена (озвучка выключена или повтор). */
  say(msg: SpeechMessage): boolean {
    if (!this.enabled || !msg.text.trim()) return false;
    if (msg.key && (this.queue.some((i) => i.msg.key === msg.key) || this.current?.msg.key === msg.key)) return false;
    const item: Item = { msg, expiresAt: this.clock.now() + (msg.ttlMs ?? DEFAULT_TTL_MS[msg.priority]) };
    if (msg.priority === 'nav') {
      // навигация встаёт перед всеми тренировочными фразами, но после уже ждущей навигации
      let at = this.queue.length;
      while (at > 0 && this.queue[at - 1].msg.priority === 'training') at--;
      this.queue.splice(at, 0, item);
      this.trim('nav');
      if (this.current?.msg.priority === 'training') void this.safeStop(); // тренировочная фраза уступает
    } else {
      this.queue.push(item);
      this.trim('training');
    }
    void this.run();
    return true;
  }

  /** Выключить озвучку: очередь очищается, текущая фраза обрывается. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clear();
  }

  clear(): void {
    this.queue = [];
    if (this.current) void this.safeStop();
  }

  /** Дождаться, пока очередь опустеет (нужно тестам и перед завершением экрана). */
  idle(): Promise<void> {
    return this.running ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  private trim(p: SpeechPriority): void {
    const mine = this.queue.filter((i) => i.msg.priority === p);
    for (let extra = mine.length - MAX_QUEUED[p], k = 0; extra > 0; extra--, k++) {
      this.queue.splice(this.queue.indexOf(mine[k]), 1); // самые старые уступают место новым
      this.dropped++;
    }
  }

  private async safeStop(): Promise<void> { try { await this.engine.stop(); } catch { /* необязательно */ } }

  private next(): Item | null {
    while (this.queue.length) {
      const it = this.queue.shift()!;
      if (it.expiresAt >= this.clock.now()) return it;
      this.dropped++; // опоздала: лучше промолчать, чем сказать про поворот, который уже позади
    }
    return null;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let it = this.next(); it; it = this.next()) {
        this.current = it;
        let timer: unknown;
        try {
          await Promise.race([
            this.engine.speak(it.msg.text),
            new Promise<void>((r) => { timer = this.clock.setTimeout(r, MAX_SPEAK_MS); })
          ]);
        } catch { /* сбой движка: идём дальше */ }
        this.clock.clearTimeout(timer);
        this.current = null;
      }
    } finally {
      this.running = false;
      const w = this.waiters; this.waiters = [];
      w.forEach((r) => r());
    }
  }
}
