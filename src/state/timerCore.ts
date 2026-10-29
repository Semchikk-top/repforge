// Чистая логика таймера отдыха: без React и часов, чтобы её можно было проверить тестами.
// Таймер хранит момент окончания (endsAt), а не «тики»: при сворачивании приложения остаток считается верно.
// На паузе остаток заморожен в pausedLeftMs, а endsAt не используется.

export interface TimerState { endsAt: number; total: number; pausedLeftMs?: number }

export const isPaused = (s: TimerState | null | undefined): boolean => typeof s?.pausedLeftMs === 'number';

export const remainingMs = (s: TimerState, now: number): number =>
  isPaused(s) ? s.pausedLeftMs! : Math.max(0, s.endsAt - now);

export const startState = (sec: number, now: number): TimerState => ({ endsAt: now + sec * 1000, total: sec });

/** Поставить на паузу. Если отсчёт уже закончился, ставить нечего: состояние не меняется. */
export function pauseState(s: TimerState, now: number): TimerState {
  if (isPaused(s)) return s;
  const left = s.endsAt - now;
  return left <= 0 ? s : { endsAt: s.endsAt, total: s.total, pausedLeftMs: left };
}

/** Продолжить: остаток отсчитывается заново от текущего момента. */
export function resumeState(s: TimerState, now: number): TimerState {
  return isPaused(s) ? { endsAt: now + s.pausedLeftMs!, total: s.total } : s;
}

/** ±секунды. Остаток не опускается ниже секунды, чтобы «−15» не обрывало отдых мгновенно. */
export function addState(s: TimerState, sec: number, now: number): TimerState {
  const total = Math.max(1, s.total + sec);
  if (isPaused(s)) return { endsAt: s.endsAt, total, pausedLeftMs: Math.max(1000, s.pausedLeftMs! + sec * 1000) };
  return { endsAt: Math.max(now + 1000, s.endsAt + sec * 1000), total };
}

/** Что делать с сохранённым состоянием после перезапуска: истёкшее отбрасываем, а паузу сохраняем. */
export function restoreState(raw: unknown, now: number): TimerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<TimerState>;
  if (typeof s.endsAt !== 'number' || typeof s.total !== 'number' || !Number.isFinite(s.endsAt) || !Number.isFinite(s.total)) return null;
  if (typeof s.pausedLeftMs === 'number') return s.pausedLeftMs > 0 && Number.isFinite(s.pausedLeftMs) ? { endsAt: s.endsAt, total: s.total, pausedLeftMs: s.pausedLeftMs } : null;
  return s.endsAt > now ? { endsAt: s.endsAt, total: s.total } : null;
}
