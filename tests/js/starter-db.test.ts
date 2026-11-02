import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { applyStarterPlan, ensureSeeds } from '../../src/db/repo';
import { planProgram } from '../../src/domain/programs';
import { recommendPrograms } from '../../src/domain/starter';

const base = { goal: 'muscle', experience: 'beginner', days: 3, equipment: 'gym' } as const;

beforeEach(async () => {
  await Promise.all([db.exercises.clear(), db.templates.clear(), db.programs.clear(), db.workouts.clear(), db.changes.clear()]);
  await ensureSeeds();
});

describe('создание стартовой программы', () => {
  it('создаёт шаблон на каждую тренировку и программу с их днями недели', async () => {
    const plan = recommendPrograms(base)[0];
    const id = await applyStarterPlan(plan, '2026-11-02');
    const program = (await db.programs.get(id))!;
    const templates = await db.templates.toArray();
    expect(templates).toHaveLength(plan.sessions.length);
    expect(program).toMatchObject({ title: plan.title, startDate: '2026-11-02', weeks: 8 });
    expect(program.days.map((d) => d.weekday)).toEqual(plan.weekdays);
    for (const [i, d] of program.days.entries()) {
      const t = templates.find((x) => x.id === d.templateId)!;
      expect(t.title).toBe(plan.sessions[i].title);
      expect(t.exercises).toHaveLength(plan.sessions[i].exercises.length);
      expect(t.exercises.every((e) => e.weight === 0 && e.sets >= 1 && e.reps >= 1)).toBe(true);
    }
  });

  it('все упражнения шаблонов существуют в базе', async () => {
    for (const equipment of ['gym', 'dumbbells', 'bodyweight'] as const) {
      await db.templates.clear();
      await applyStarterPlan(recommendPrograms({ ...base, equipment, experience: 'intermediate', days: 4 })[0], '2026-11-02');
      const ids = new Set((await db.exercises.toArray()).map((e) => e.id));
      for (const t of await db.templates.toArray()) for (const e of t.exercises) expect(ids.has(e.exerciseId), e.exerciseId).toBe(true);
    }
  });

  it('недостающие упражнения создаются один раз и не дублируются при повторном выборе', async () => {
    const plan = recommendPrograms({ ...base, equipment: 'bodyweight' })[0];
    const before = await db.exercises.count();
    await applyStarterPlan(plan, '2026-11-02');
    await applyStarterPlan(plan, '2026-11-09');
    expect(await db.exercises.count()).toBe(before + plan.newExercises.length);
    const created = await db.exercises.get(plan.newExercises[0].id);
    expect(created).toMatchObject({ custom: true, name: plan.newExercises[0].name });
  });

  it('существующие упражнения не меняются', async () => {
    const plan = recommendPrograms(base)[0];
    const seed = (await db.exercises.get(plan.sessions[0].exercises[0].exerciseId))!;
    await applyStarterPlan(plan, '2026-11-02');
    expect(await db.exercises.get(seed.id)).toEqual(seed);
  });

  it('всё попадает в очередь синхронизации', async () => {
    const plan = recommendPrograms({ ...base, equipment: 'bodyweight' })[0];
    await db.changes.clear();
    await applyStarterPlan(plan, '2026-11-02');
    const by = (t: string) => ['exercises', 'templates', 'programs'].includes(t);
    const ch = (await db.changes.toArray()).filter((c) => by(c.table));
    expect(ch.filter((c) => c.table === 'templates')).toHaveLength(plan.sessions.length);
    expect(ch.filter((c) => c.table === 'programs')).toHaveLength(1);
    expect(ch.filter((c) => c.table === 'exercises')).toHaveLength(plan.newExercises.length);
  });

  it('созданная программа раскладывается в календарь на восемь недель', async () => {
    const plan = recommendPrograms(base)[0];
    const id = await applyStarterPlan(plan, '2026-11-02');
    const program = (await db.programs.get(id))!;
    const templates = new Map((await db.templates.toArray()).map((t) => [t.id, t]));
    const exMap = new Map((await db.exercises.toArray()).map((e) => [e.id, e]));
    const r = planProgram({ program, templates, existing: [], history: [], exMap, today: '2026-11-02' });
    expect(r.missingTemplates).toBe(0);
    expect(r.slots).toHaveLength(8 * plan.sessions.length);
    expect(r.slots[0]).toMatchObject({ date: '2026-11-02', title: plan.sessions[0].title });
    expect(r.slots[0].exercises).toHaveLength(plan.sessions[0].exercises.length);
  });
});
