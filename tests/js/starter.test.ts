import { describe, expect, it } from 'vitest';
import { missingExercises, recommendPrograms, shouldOfferOnboarding, starterExerciseId, type Answers } from '../../src/domain/starter';
import { SEED_EXERCISES } from '../../src/domain/seed';
import { MUSCLE_LABELS } from '../../src/domain/types';

const base: Answers = { goal: 'muscle', experience: 'beginner', days: 3, equipment: 'gym' };
const seeds = SEED_EXERCISES.map((e) => ({ id: e.id }));

describe('подбор стартовых программ', () => {
  it('для любого сочетания ответов есть хотя бы одна программа, и не больше трёх', () => {
    for (const goal of ['strength', 'muscle', 'general'] as const)
      for (const experience of ['beginner', 'intermediate'] as const)
        for (const days of [2, 3, 4] as const)
          for (const equipment of ['gym', 'dumbbells', 'bodyweight'] as const) {
            const r = recommendPrograms({ goal, experience, days, equipment });
            expect(r.length, JSON.stringify({ goal, experience, days, equipment })).toBeGreaterThanOrEqual(1);
            expect(r.length).toBeLessThanOrEqual(3);
          }
  });

  it('число тренировок в неделю не больше выбранного, лучшее совпадение идёт первым', () => {
    for (const days of [2, 3, 4] as const) {
      const r = recommendPrograms({ ...base, days });
      expect(r.every((p) => p.sessions.length <= days)).toBe(true);
      expect(r[0].sessions.length).toBe(days);
    }
  });

  it('новичку на 3 дня предлагается «всё тело», опытному — разделение жим/тяга/ноги первым или рядом', () => {
    expect(recommendPrograms({ ...base, days: 3 })[0].id).toBe('fb3');
    expect(recommendPrograms({ ...base, experience: 'intermediate', days: 3 }).map((p) => p.id)).toContain('ppl3');
    expect(recommendPrograms({ ...base, days: 4 })[0].id).toBe('ul4');
  });

  it('дни недели соответствуют числу тренировок и идут по возрастанию, без повторов', () => {
    for (const days of [2, 3, 4] as const) for (const p of recommendPrograms({ ...base, days })) {
      expect(p.weekdays).toHaveLength(p.sessions.length);
      expect([...p.weekdays].sort()).toEqual(p.weekdays);
      expect(new Set(p.weekdays).size).toBe(p.weekdays.length);
      expect(p.weekdays.every((d) => d >= 1 && d <= 7)).toBe(true);
    }
  });

  it('цель меняет подходы и повторы: сила 5×5 в основных, мышцы 3×8, общая форма 3×10', () => {
    const first = (goal: Answers['goal']) => recommendPrograms({ ...base, goal })[0].sessions[0].exercises[0];
    expect([first('strength').sets, first('strength').reps]).toEqual([5, 5]);
    expect([first('muscle').sets, first('muscle').reps]).toEqual([3, 8]);
    expect([first('general').sets, first('general').reps]).toEqual([3, 10]);
  });

  it('новичку меньше упражнений в тренировке, чем опытному', () => {
    const count = (experience: Answers['experience']) => Math.max(...recommendPrograms({ ...base, experience, days: 3 }).flatMap((p) => p.sessions.map((s) => s.exercises.length)));
    expect(count('beginner')).toBeLessThanOrEqual(5);
    expect(count('intermediate')).toBeGreaterThan(count('beginner') - 1);
  });

  it('упражнения не повторяются внутри тренировки, подходы и повторы положительны', () => {
    for (const equipment of ['gym', 'dumbbells', 'bodyweight'] as const) for (const p of recommendPrograms({ ...base, experience: 'intermediate', days: 4, equipment })) for (const s of p.sessions) {
      const names = s.exercises.map((e) => e.name);
      expect(new Set(names).size).toBe(names.length);
      expect(s.exercises.length).toBeGreaterThanOrEqual(2);
      expect(s.exercises.every((e) => e.sets >= 1 && e.reps >= 1)).toBe(true);
    }
  });

  it('все упражнения либо стартовые, либо создаются вместе с программой', () => {
    for (const equipment of ['gym', 'dumbbells', 'bodyweight'] as const) for (const p of recommendPrograms({ ...base, experience: 'intermediate', days: 4, equipment })) {
      expect(missingExercises(p, seeds)).toEqual([]);
      for (const e of p.newExercises) {
        expect(e.id).toBe(starterExerciseId(e.name));
        expect(MUSCLE_LABELS[e.muscle]).toBeTruthy();
        expect(e.equipment).toBeTruthy();
      }
    }
  });

  it('без оборудования предупреждение о коротком наборе, новые упражнения создаются, а стартовые id не меняются', () => {
    const p = recommendPrograms({ ...base, equipment: 'bodyweight' })[0];
    expect(p.note).toContain('Без оборудования');
    expect(p.newExercises.map((e) => e.name).sort()).toEqual(['Отжимания от пола', 'Приседания без веса']);
    expect(starterExerciseId('Жим штанги лёжа')).toBe(SEED_EXERCISES.find((e) => e.name === 'Жим штанги лёжа')!.id);
    expect(recommendPrograms(base)[0].newExercises).toEqual([]);
  });

  it('планка записывается секундами, и об этом сказано в пояснении', () => {
    const p = recommendPrograms(base)[0];
    const plank = p.sessions.flatMap((s) => s.exercises).find((e) => e.name === 'Планка')!;
    expect([plank.sets, plank.reps]).toEqual([3, 30]);
    expect(p.note).toContain('секунды');
  });
});

describe('когда предлагать онбординг', () => {
  const empty = { workouts: 0, templates: 0, programs: 0 };
  it('только при полностью пустом дневнике и без отказа', () => {
    expect(shouldOfferOnboarding(empty, false)).toBe(true);
    expect(shouldOfferOnboarding(empty, true)).toBe(false);
    expect(shouldOfferOnboarding({ ...empty, workouts: 1 }, false)).toBe(false);
    expect(shouldOfferOnboarding({ ...empty, templates: 1 }, false)).toBe(false);
    expect(shouldOfferOnboarding({ ...empty, programs: 1 }, false)).toBe(false);
  });
});
