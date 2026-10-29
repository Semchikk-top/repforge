// Presence: что видит друг. Только то, что нужно для координации, — вес, повторы, заметки и ID сюда не попадают.

export type PresencePhase = 'idle' | 'working' | 'resting';

export interface Presence {
  v: 1;
  phase: PresencePhase;
  workoutTitle?: string;
  exerciseName?: string;
  setIndex?: number;
  setTotal?: number;
  restRemainingSec?: number;
  restTotalSec?: number;
  /** Тумблер «Показывать, что я делаю» выключен: друг видит только это. */
  hidden?: boolean;
  updatedAt: number; // часы отправителя, только для отображения
}

export const STALE_AFTER_MS = 30_000;

/** Упрощённый вид тренировки: так построитель не зависит от базы и легко проверяется. */
export interface PresenceWorkout {
  title: string;
  exercises: Array<{
    name: string;
    cardio: boolean;
    cardioDone: boolean;
    sets: Array<{ done: boolean; completedAt?: number }>;
  }>;
}

const clip = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

/**
 * Что сейчас делает человек.
 * В работе: «подход N/M» — подход, который выполняется. В отдыхе: N — подход, который только что закончен.
 */
export function buildPresence(input: {
  workout: PresenceWorkout | null;
  rest: { remainingSec: number; totalSec: number } | null;
  share: boolean;
  now: number;
}): Presence {
  const { workout, rest, share, now } = input;
  if (!share) return { v: 1, phase: 'idle', hidden: true, updatedAt: now };
  if (!workout) return { v: 1, phase: 'idle', updatedAt: now };

  const base = { v: 1 as const, workoutTitle: clip(workout.title, 40) || undefined, updatedAt: now };
  const exs = workout.exercises;
  if (exs.length === 0) return { ...base, phase: 'working' };

  const resting = !!rest && rest.remainingSec > 0;
  let idx = -1;
  if (resting) {
    // отдых идёт после последнего выполненного подхода
    let best = -1;
    exs.forEach((e, i) => e.sets.forEach((s) => { if (s.done && (s.completedAt ?? 0) >= best) { best = s.completedAt ?? 0; idx = i; } }));
  }
  if (idx < 0) idx = exs.findIndex((e) => (e.cardio ? !e.cardioDone : e.sets.some((s) => !s.done)));
  if (idx < 0) idx = exs.length - 1; // всё выполнено, но тренировка не завершена

  const ex = exs[idx];
  const out: Presence = { ...base, phase: resting ? 'resting' : 'working', exerciseName: clip(ex.name, 60) || undefined };
  if (!ex.cardio && ex.sets.length > 0) {
    const done = ex.sets.filter((s) => s.done).length;
    out.setTotal = Math.min(ex.sets.length, 99);
    out.setIndex = resting ? Math.max(1, Math.min(done, out.setTotal)) : Math.min(done + 1, out.setTotal);
  }
  if (resting && rest) {
    out.restRemainingSec = Math.ceil(rest.remainingSec);
    out.restTotalSec = Math.ceil(rest.totalSec);
  }
  return out;
}

/** Всё, кроме секунд и времени отправки: по смене этого ключа presence отправляется сразу. */
export function presenceKey(p: Presence): string {
  return [p.phase, p.hidden ? 1 : 0, p.workoutTitle ?? '', p.exerciseName ?? '', p.setIndex ?? '', p.setTotal ?? '', p.restTotalSec ?? ''].join('|');
}

/** Решает, когда слать presence: при смене упражнения/подхода/таймера. Heartbeat шлёт менеджер комнаты. */
export class PresenceSender {
  private lastKey = '';
  private lastAt = 0;
  private lastRest = 0;

  shouldSend(p: Presence, now: number): boolean {
    if (presenceKey(p) !== this.lastKey) return true;
    if (p.restRemainingSec !== undefined) {
      // друг ведёт отсчёт сам; шлём заново, только если таймер подвинули (±15 с, пропуск)
      const expected = this.lastRest - (now - this.lastAt) / 1000;
      if (Math.abs(expected - p.restRemainingSec) > 2) return true;
    }
    return false;
  }

  mark(p: Presence, now: number): void {
    this.lastKey = presenceKey(p);
    this.lastAt = now;
    this.lastRest = p.restRemainingSec ?? 0;
  }

  reset(): void { this.lastKey = ''; this.lastAt = 0; this.lastRest = 0; }
}

const int = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : undefined;
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && clip(v, max) ? clip(v, max) : undefined);

/** Принимаем только известные поля с разумными значениями: всё остальное отбрасываем. */
export function sanitizePresence(raw: unknown): Presence | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (r.phase !== 'idle' && r.phase !== 'working' && r.phase !== 'resting') return null;
  const p: Presence = { v: 1, phase: r.phase, updatedAt: int(r.updatedAt, 0, 8.64e15) ?? 0 };
  if (r.hidden === true) p.hidden = true;
  const title = str(r.workoutTitle, 40); if (title) p.workoutTitle = title;
  const name = str(r.exerciseName, 60); if (name) p.exerciseName = name;
  const si = int(r.setIndex, 1, 99); if (si !== undefined) p.setIndex = si;
  const st = int(r.setTotal, 1, 99); if (st !== undefined) p.setTotal = st;
  const rr = int(r.restRemainingSec, 0, 3600); if (rr !== undefined) p.restRemainingSec = rr;
  const rt = int(r.restTotalSec, 0, 3600); if (rt !== undefined) p.restTotalSec = rt;
  if (p.setIndex !== undefined && p.setTotal !== undefined && p.setIndex > p.setTotal) p.setIndex = p.setTotal;
  return p;
}

export interface RemotePresence { p: Presence; receivedAt: number }

export const isStale = (r: RemotePresence, now: number) => now - r.receivedAt > STALE_AFTER_MS;

/** Остаток отдыха по нашим часам: время друга не нужно, считаем от момента получения. */
export function restLeft(r: RemotePresence, now: number): number {
  return Math.max(0, (r.p.restRemainingSec ?? 0) - (now - r.receivedAt) / 1000);
}

const clock = (sec: number) => { const s = Math.max(0, Math.ceil(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function describePresence(r: RemotePresence, now: number): { text: string; short: string; stale: boolean } {
  const { p } = r;
  const stale = isStale(r, now);
  if (p.hidden) return { text: 'не показывает, что делает', short: 'не показывает, что делает', stale: false };
  if (p.phase === 'idle') return { text: 'не на тренировке', short: 'не на тренировке', stale };
  const sets = p.setIndex !== undefined && p.setTotal !== undefined ? `подход ${p.setIndex}/${p.setTotal}` : '';
  const shortSets = p.setIndex !== undefined && p.setTotal !== undefined ? ` ${p.setIndex}/${p.setTotal}` : '';
  if (p.phase === 'resting' && !stale) {
    const left = clock(restLeft(r, now));
    return {
      text: [p.exerciseName, sets, `отдых ${left}`].filter(Boolean).join(' · '),
      short: `отдыхает ${left}`,
      stale
    };
  }
  // устаревшее состояние не рисуем «живым» таймером
  const base = p.exerciseName ?? 'тренируется';
  return { text: [base, sets, stale && p.phase === 'resting' ? 'отдых' : ''].filter(Boolean).join(' · '), short: `${base}${shortSets}`, stale };
}
