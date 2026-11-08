// Чистая логика плашки уборки: без React и таймера, чтобы её проверяли тесты.
// Плашка — не таймер: у неё нет длительности, фоновых уведомлений и сохранения между запусками.

export interface CleanupGate {
  /** Что убрать: название упражнения или связки. */
  label: string;
  /** Отдых, который запустится после галочки. null или ≤ 0 — отдыха нет, галочка просто закрывает плашку. */
  restSec: number | null;
}

/** Что делать после отметки рабочего подхода. */
export type AfterSet =
  | { kind: 'rest'; sec: number }       // обычный отдых сразу
  | { kind: 'gate'; gate: CleanupGate } // плашка вместо отдыха, отдых отложен
  | { kind: 'none' };                   // отдыха нет (суперсет, дроп-сет)

export function planAfterSet(opts: { enabled: boolean; show: boolean; rest: number | null; label: string }): AfterSet {
  if (opts.enabled && opts.show) return { kind: 'gate', gate: { label: opts.label, restSec: opts.rest } };
  return opts.rest === null ? { kind: 'none' } : { kind: 'rest', sec: opts.rest };
}

/** Галочка на плашке: плашка исчезает, обычный отдых запускается с той же длительностью, что была бы без неё. */
export function confirmGate(gate: CleanupGate | null): { gate: null; startRestSec: number | null } {
  const sec = gate?.restSec;
  return { gate: null, startRestSec: typeof sec === 'number' && sec > 0 ? sec : null };
}
