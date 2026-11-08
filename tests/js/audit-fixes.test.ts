import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { canUndoEase, easeWorkout } from '../../src/domain/autoregulation';
import { sanitizeSettings } from '../../src/db/backupInspect';
import { exportAll, importAll, loadSettings, saveSettings } from '../../src/db/repo';
import { DEFAULT_SETTINGS, type Workout } from '../../src/domain/types';
import { expandPlan, initialIntervalState, intervalStep, skipStep, type IntervalSample } from '../../src/cardio/intervals';
import { SseParser } from '../../src/sync/live';

const sm = (activeSec: number): IntervalSample => ({ activeSec, distanceM: 0, paceSecPerKm: null, hrBpm: null, maxHr: null });

describe('отмена «Сделать легче»', () => {
  const w: Workout = {
    id: 'w', createdAt: 0, updatedAt: 0, deviceId: 'd', date: '2026-11-05', title: 'Т', status: 'active',
    exercises: [{ id: 'e', exerciseId: 'x', sets: [{ id: 's1', weight: 100, reps: 5, done: false }, { id: 's2', weight: 100, reps: 5, done: false }] }]
  };
  it('пока тренировку не трогали после поправки, откат разрешён', () => {
    const eased = easeWorkout(w, { pct: 5 }).workout;
    expect(canUndoEase(eased, eased)).toBe(true);
  });
  it('если после поправки отметили подход или поменяли вес, откат запрещён: он стёр бы эти правки', () => {
    const eased = easeWorkout(w, { pct: 5 }).workout;
    const progressed: Workout = { ...eased, exercises: [{ ...eased.exercises[0], sets: eased.exercises[0].sets.map((s, i) => (i === 0 ? { ...s, done: true } : s)) }] };
    expect(canUndoEase(progressed, eased)).toBe(false);
    const edited: Workout = { ...eased, exercises: [{ ...eased.exercises[0], sets: eased.exercises[0].sets.map((s) => ({ ...s, weight: 50 })) }] };
    expect(canUndoEase(edited, eased)).toBe(false);
  });
});

describe('настройки из копии', () => {
  it('известные поля с верным типом принимаются', () => {
    const s = sanitizeSettings({ theme: 'light', defaultRestSec: 120, plates: [20, 10, 5], reminderTime: '07:30', assistantBackend: 'local', keepAwake: false });
    expect(s).toMatchObject({ theme: 'light', defaultRestSec: 120, plates: [20, 10, 5], reminderTime: '07:30', assistantBackend: 'local', keepAwake: false });
  });
  it('неверный тип, значение вне диапазона и посторонние поля заменяются умолчаниями или отбрасываются', () => {
    const s = sanitizeSettings({ theme: 'neon', defaultRestSec: '90', weightStep: -1, plates: 'много', maxHr: Infinity, reminderTime: '25:99', assistantBackend: 'evil', hack: 1, __proto__: { x: 1 } }) as unknown as Record<string, unknown>;
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.defaultRestSec).toBe(DEFAULT_SETTINGS.defaultRestSec);
    expect(s.weightStep).toBe(DEFAULT_SETTINGS.weightStep);
    expect(s.plates).toEqual(DEFAULT_SETTINGS.plates);
    expect(s.maxHr).toBe(DEFAULT_SETTINGS.maxHr);
    expect(s.reminderTime).toBe(DEFAULT_SETTINGS.reminderTime);
    expect(s.assistantBackend).toBeUndefined();
    expect('hack' in s).toBe(false);
  });
  it('блины: пустые, отрицательные и слишком длинные списки отклоняются', () => {
    expect(sanitizeSettings({ plates: [20, -5] }).plates).toEqual(DEFAULT_SETTINGS.plates);
    expect(sanitizeSettings({ plates: [20, NaN] }).plates).toEqual(DEFAULT_SETTINGS.plates);
    expect(sanitizeSettings({ plates: Array(31).fill(5) }).plates).toEqual(DEFAULT_SETTINGS.plates);
  });
  it('не объект вместо настроек даёт умолчания', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1])).toEqual(DEFAULT_SETTINGS);
  });
  it('импорт копии с испорченными настройками не ломает приложение', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, theme: 'light' });
    const data = JSON.parse(await exportAll());
    data.settings = { ...data.settings, plates: 'не список', theme: 5, weightStep: 5 };
    await importAll(JSON.stringify(data));
    const s = await loadSettings();
    expect(Array.isArray(s.plates)).toBe(true);
    expect(s.theme).toBe('dark');
    expect(s.weightStep).toBe(5);
  });
});

describe('SseParser: перевод строки \\r\\n, разорванный между кусками', () => {
  it('«\\r» в конце куска и «\\n» в начале следующего не дают лишней пустой строки', () => {
    const p = new SseParser();
    expect(p.push('event: seq\r')).toEqual([]);
    expect(p.push('\ndata: 1\r\n\r')).toEqual([]);
    expect(p.push('\n')).toEqual([{ event: 'seq', data: '1' }]);
  });
  it('одиночный \\r внутри потока по-прежнему конец строки', () => {
    expect(new SseParser().push('event: a\rdata: b\r\r')).toEqual([]);
    expect(new SseParser().push('event: a\rdata: b\r\rx')).toEqual([{ event: 'a', data: 'b' }]);
  });
});

describe('испорченное сохранённое состояние интервалов', () => {
  const steps = expandPlan({ reps: 1, work: { length: { by: 'time', sec: 30 } } });
  it('индекс за пределами плана не роняет движок и завершает план', () => {
    const bad = { ...initialIntervalState(), started: true, index: 99 };
    const r = intervalStep(steps, bad, sm(10));
    expect(r.state.done).toBe(true);
    expect(r.events).toEqual([]);
    expect(skipStep(steps, bad, sm(10)).events).toEqual([]);
  });
});
