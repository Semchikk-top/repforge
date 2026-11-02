// «Что делать сегодня»: совет для главного экрана.
import { describe, expect, it } from 'vitest';
import { dayWord, nextInCycle, todayAdvice, trainingStreak, type TodayInput } from '../../src/domain/today';
import type { Workout } from '../../src/domain/types';

const TODAY = '2026-11-04'; // среда

const set = (done: boolean, weight = 60, reps = 8) => ({ id: Math.random().toString(36).slice(2), weight, reps, done });
let n = 0;
const wk = (date: string, title: string, status: Workout['status'], extra: Partial<Workout> = {}): Workout => ({
  id: `w${++n}`, createdAt: 1000 + n, updatedAt: 1000 + n, deviceId: 'd', date, title, status,
  exercises: [{ id: `e${n}`, exerciseId: 'seed-001', sets: status === 'planned' ? [set(false)] : [set(true), set(true)] }],
  ...(status === 'done' ? { finishedAt: 5000 + n } : {}), ...(status === 'active' ? { startedAt: 7000 + n } : {}), ...extra
}) as Workout;

const input = (workouts: Workout[], extra: Partial<TodayInput> = {}): TodayInput =>
  ({ today: TODAY, workouts, hasPlan: false, onboardingOffered: false, readiness: null, ...extra });

describe('что делать сегодня', () => {
  it('идущая тренировка важнее всего', () => {
    const a = todayAdvice(input([wk(TODAY, 'Грудь', 'planned'), wk(TODAY, 'Спина', 'active')]));
    expect(a.kind).toBe('continue');
    expect(a.headline).toContain('Спина');
    expect(a.primary?.action).toMatchObject({ type: 'open' });
  });

  it('запланировано на сегодня: «Начать», число упражнений и запасной вариант', () => {
    const a = todayAdvice(input([wk(TODAY, 'Ноги', 'planned'), wk('2026-11-05', 'Грудь', 'planned')]));
    expect(a).toMatchObject({ kind: 'planned', headline: 'Сегодня: Ноги', primary: { label: 'Начать' }, secondary: { action: { type: 'start' } } });
    expect(a.detail).toContain('1 упражнение');
  });

  it('несколько тренировок на сегодня: говорит об остальных', () => {
    const a = todayAdvice(input([wk(TODAY, 'Ноги', 'planned'), wk(TODAY, 'Руки', 'planned')]));
    expect(a.detail).toContain('Ещё на сегодня: 1');
  });

  it('плохой чек-ин добавляет совет снизить нагрузку', () => {
    expect(todayAdvice(input([wk(TODAY, 'Ноги', 'planned')], { readiness: 'low' })).detail).toMatch(/сил меньше обычного/);
    expect(todayAdvice(input([wk(TODAY, 'Ноги', 'planned')], { readiness: 'high' })).detail).not.toMatch(/сил меньше/);
  });

  it('сегодня уже потренировался: итог и следующая по плану', () => {
    const a = todayAdvice(input([wk(TODAY, 'Грудь', 'done'), wk('2026-11-06', 'Спина', 'planned')]));
    expect(a.kind).toBe('done');
    expect(a.detail).toContain('2 подхода');
    expect(a.detail).toContain('в пятницу, 6 ноября');
    expect(a.primary?.label).toBe('Что дальше');
    expect(todayAdvice(input([wk(TODAY, 'Грудь', 'done')])).detail).toMatch(/не запланировал/);
  });

  it('пропущенная на этой неделе предлагается к переносу, давняя нет', () => {
    const a = todayAdvice(input([wk('2026-11-02', 'Грудь', 'planned'), wk('2026-10-20', 'Старая', 'planned'), wk('2026-11-03', 'Вчера сделал', 'done')]));
    expect(a).toMatchObject({ kind: 'missed', primary: { label: 'Сделать сегодня', action: { type: 'move' } } });
    expect(a.headline).toContain('Грудь');
    expect(todayAdvice(input([wk('2026-10-20', 'Старая', 'planned'), wk('2026-10-19', 'Сделано', 'done')])).kind).not.toBe('missed');
  });

  describe('новичок', () => {
    it('пустой дневник и карточка подбора не закрыта: ведёт в подбор программы, показывает шаги', () => {
      const a = todayAdvice(input([], { onboardingOffered: true }));
      expect(a).toMatchObject({ kind: 'first', primary: { action: { type: 'onboarding' } }, secondary: { action: { type: 'start' } } });
      expect(a.steps).toHaveLength(3);
      expect(a.steps!.map((s) => s.done)).toEqual([false, false, false]);
    });
    it('подбор закрыли: просто «Начать тренировку»', () => {
      const a = todayAdvice(input([]));
      expect(a).toMatchObject({ kind: 'first', primary: { label: 'Начать тренировку', action: { type: 'start' } } });
      expect(a.secondary).toBeUndefined();
    });
    it('первый шаг засчитывается, когда план уже есть', () => {
      expect(todayAdvice(input([], { hasPlan: true })).steps![0].done).toBe(true);
    });
    it('первая тренировка стоит в плане на потом: можно открыть или начать раньше', () => {
      const a = todayAdvice(input([wk('2026-11-07', 'Фуллбади', 'planned')], { hasPlan: true }));
      expect(a).toMatchObject({ kind: 'first', primary: { action: { type: 'open' } }, secondary: { label: 'Начать сейчас' } });
      expect(a.detail).toContain('Фуллбади');
      expect(a.steps![0].done).toBe(true);
    });
  });

  describe('отдых', () => {
    it('три дня подряд: отдыхать, но можно и потренироваться', () => {
      const a = todayAdvice(input([wk('2026-11-03', 'A', 'done'), wk('2026-11-02', 'B', 'done'), wk('2026-11-01', 'C', 'done')]));
      expect(a).toMatchObject({ kind: 'rest', headline: 'Сегодня лучше отдохнуть', secondary: { label: 'Всё равно потренироваться' } });
      expect(a.detail).toContain('3 дня подряд');
    });
    it('вчера тренировка и слабый чек-ин: отдых', () => {
      const a = todayAdvice(input([wk('2026-11-03', 'A', 'done')], { readiness: 'low' }));
      expect(a.kind).toBe('rest');
    });
    it('слабый чек-ин без вчерашней тренировки отдыхом не заканчивается', () => {
      expect(todayAdvice(input([wk('2026-11-01', 'A', 'done')], { readiness: 'low' })).kind).toBe('suggest');
    });
    it('по плану ближайшая через несколько дней: сегодня отдых', () => {
      const a = todayAdvice(input([wk('2026-11-03', 'A', 'done'), wk('2026-11-06', 'Спина', 'planned')]));
      expect(a).toMatchObject({ kind: 'rest', headline: 'Сегодня по плану отдых', primary: { action: { type: 'open' } } });
      expect(a.detail).toContain('в пятницу, 6 ноября');
    });
    it('дальняя запланированная (через две недели) отдыхом не считается', () => {
      expect(todayAdvice(input([wk('2026-11-01', 'A', 'done'), wk('2026-11-25', 'Далеко', 'planned')])).kind).toBe('suggest');
    });
  });

  describe('предложение по ритму', () => {
    it('A, B, A, B: после B предлагается A (самая свежая версия)', () => {
      const ws = [wk('2026-10-20', 'Грудь', 'done'), wk('2026-10-22', 'Спина', 'done'), wk('2026-10-27', 'Грудь', 'done'), wk('2026-10-30', 'Спина', 'done')];
      const a = todayAdvice(input(ws));
      expect(a).toMatchObject({ kind: 'suggest', headline: 'Можно: Грудь', primary: { label: 'Начать', action: { type: 'repeat', workoutId: ws[2].id } } });
      expect(a.detail).toContain('5 дн. назад');
    });
    it('ритма ещё нет: берётся то, что давнее всего не делали', () => {
      const ws = [wk('2026-10-20', 'Грудь', 'done'), wk('2026-10-24', 'Ноги', 'done'), wk('2026-10-30', 'Спина', 'done')];
      expect(nextInCycle(ws)!.title).toBe('Грудь');
    });
    it('одна и та же тренировка: предлагается она же', () => {
      expect(nextInCycle([wk('2026-10-28', 'Фуллбади', 'done'), wk('2026-10-31', 'Фуллбади', 'done')])!.title).toBe('Фуллбади');
      expect(nextInCycle([])).toBeNull();
    });
    it('длинный перерыв: просит начать полегче', () => {
      const a = todayAdvice(input([wk('2026-10-10', 'Грудь', 'done')]));
      expect(a.kind).toBe('suggest');
      expect(a.detail).toMatch(/полегче/);
    });
    it('перенесённая история годится, пока нет своих тренировок, но своя главнее', () => {
      const imp = wk('2026-10-30', 'Импортированная', 'done', { imported: true });
      expect(todayAdvice(input([imp])).headline).toContain('Импортированная');
      expect(todayAdvice(input([imp, wk('2026-10-28', 'Своя', 'done')])).headline).toContain('Своя');
    });
    it('удалённые не учитываются', () => {
      const gone = wk(TODAY, 'Удалена', 'planned', { deletedAt: 5 });
      expect(todayAdvice(input([gone])).kind).toBe('first');
    });
  });
});

describe('вспомогательные', () => {
  it('серия дней', () => {
    const ds = (...d: string[]) => d.map((x) => wk(x, 't', 'done'));
    expect(trainingStreak(ds('2026-11-03', '2026-11-02', '2026-10-30'), TODAY)).toBe(2);
    expect(trainingStreak(ds('2026-11-02'), TODAY)).toBe(0);
    expect(trainingStreak(ds(TODAY, '2026-11-03'), TODAY)).toBe(2);
  });
  it('слова про даты', () => {
    expect(dayWord(TODAY, TODAY)).toBe('сегодня');
    expect(dayWord('2026-11-05', TODAY)).toBe('завтра');
    expect(dayWord('2026-11-03', TODAY)).toBe('вчера');
    expect(dayWord('2026-11-01', TODAY)).toBe('3 дн. назад');
    expect(dayWord('2026-11-06', TODAY)).toBe('в пятницу, 6 ноября');
    expect(dayWord('2026-11-08', TODAY)).toBe('в воскресенье, 8 ноября');
    expect(dayWord('2026-11-20', TODAY)).toBe('20 ноября');
  });
});
