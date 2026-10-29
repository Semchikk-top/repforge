import { describe, expect, it } from 'vitest';
import { addState, isPaused, pauseState, remainingMs, restoreState, resumeState, startState } from '../../src/state/timerCore';

describe('таймер отдыха: пауза', () => {
  it('на паузе остаток стоит на месте, сколько бы времени ни прошло', () => {
    const s = startState(90, 1_000_000);
    const p = pauseState(s, 1_000_000 + 30_000);
    expect(isPaused(p)).toBe(true);
    expect(remainingMs(p, 1_000_000 + 30_000)).toBe(60_000);
    expect(remainingMs(p, 1_000_000 + 10 * 60_000)).toBe(60_000);
  });

  it('продолжение отсчитывает остаток заново от текущего момента', () => {
    const p = pauseState(startState(90, 0), 30_000);
    const r = resumeState(p, 500_000);
    expect(isPaused(r)).toBe(false);
    expect(remainingMs(r, 500_000)).toBe(60_000);
    expect(remainingMs(r, 530_000)).toBe(30_000);
    expect(r.total).toBe(90);
  });

  it('повторная пауза и продолжение без паузы ничего не меняют', () => {
    const s = startState(60, 0);
    expect(resumeState(s, 10_000)).toBe(s);
    const p = pauseState(s, 10_000);
    expect(pauseState(p, 20_000)).toBe(p);
  });

  it('закончившийся отсчёт на паузу не ставится', () => {
    const s = startState(10, 0);
    expect(pauseState(s, 10_000)).toBe(s);
    expect(pauseState(s, 99_000)).toBe(s);
  });

  it('±15 секунд работают и на паузе, остаток не уходит ниже секунды', () => {
    const p = pauseState(startState(90, 0), 30_000); // осталось 60 с
    expect(remainingMs(addState(p, 15, 40_000), 40_000)).toBe(75_000);
    const low = addState(p, -300, 40_000);
    expect(remainingMs(low, 40_000)).toBe(1000);
    expect(isPaused(low)).toBe(true);
    expect(low.total).toBe(1);
  });

  it('±15 секунд на ходу двигают конец отсчёта', () => {
    const s = startState(60, 0);
    expect(remainingMs(addState(s, 15, 10_000), 10_000)).toBe(65_000);
    expect(remainingMs(addState(s, -15, 10_000), 10_000)).toBe(35_000);
    expect(remainingMs(addState(s, -500, 10_000), 10_000)).toBe(1000);
  });

  it('после перезапуска пауза сохраняется, а истёкший таймер отбрасывается', () => {
    const p = pauseState(startState(90, 0), 30_000);
    const back = restoreState(JSON.parse(JSON.stringify(p)), 9_999_999);
    expect(back && isPaused(back)).toBe(true);
    expect(back && remainingMs(back, 9_999_999)).toBe(60_000);
    expect(restoreState({ endsAt: 1000, total: 10 }, 2000)).toBeNull();
    expect(restoreState({ endsAt: 5000, total: 10 }, 2000)).toEqual({ endsAt: 5000, total: 10 });
    expect(restoreState({ endsAt: 5000, total: 10, pausedLeftMs: 0 }, 2000)).toBeNull();
    expect(restoreState('мусор', 0)).toBeNull();
    expect(restoreState({ endsAt: 'x', total: 1 }, 0)).toBeNull();
  });
});
