import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { ensureSeeds, putExercise } from '../../src/db/repo';
import { movementOf } from '../../src/domain/movements';
import { SEED_EXERCISES } from '../../src/domain/seed';

const BEFORE = SEED_EXERCISES.slice(0, 32);
const NEW = SEED_EXERCISES.slice(32);

describe('стартовые упражнения 1.5.0', () => {
  it('добавлено 20 силовых упражнений только в конец: id первых 32 не изменились', () => {
    expect(SEED_EXERCISES).toHaveLength(52);
    expect(NEW).toHaveLength(20);
    expect(NEW[0].id).toBe('seed-033');
    expect(NEW.at(-1)!.id).toBe('seed-052');
    // зафиксированы id и названия прежних упражнений: от порядка зависят история, шаблоны и рейтинг
    expect(BEFORE[0]).toMatchObject({ id: 'seed-001', name: 'Жим штанги лёжа' });
    expect(BEFORE[10]).toMatchObject({ id: 'seed-011', name: 'Приседания со штангой' });
    expect(BEFORE[29]).toMatchObject({ id: 'seed-030', name: 'Бег', muscle: 'cardio' });
    expect(BEFORE[31]).toMatchObject({ id: 'seed-032', name: 'Велосипед' });
  });

  it('названия не повторяются и не совпадают с упражнениями, которые создаёт онбординг', () => {
    const names = SEED_EXERCISES.map((e) => e.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('отжимания от пола');
    expect(names).not.toContain('приседания без веса');
  });

  it('у всех новых есть движение, мышца силовая, оборудование заполнено', () => {
    for (const e of NEW) {
      expect(e.muscle, e.name).not.toBe('cardio');
      expect(e.equipment.trim(), e.name).not.toBe('');
      expect(movementOf({ id: e.id, name: e.name, muscle: e.muscle }), e.name).not.toBeNull();
    }
  });

  it('каждая из десяти групп получила хотя бы одно новое упражнение, кроме групп, где выбор уже полный', () => {
    const groups = new Set(NEW.map((e) => e.muscle));
    for (const g of ['chest', 'back', 'legs', 'glutes', 'shoulders', 'biceps', 'triceps', 'core', 'calves']) expect(groups.has(g as never), g).toBe(true);
  });
});

describe('обновление существующего пользователя', () => {
  beforeEach(async () => { await db.delete(); await db.open(); });

  it('ensureSeeds добавляет только недостающие, не трогая существующие и свои упражнения', async () => {
    // пользователь 1.4.x: есть первые 32 стартовых (одно из них он переименовал) и своё упражнение
    await db.exercises.bulkPut(BEFORE.map((e) => ({ ...e, createdAt: 0, updatedAt: 0, deviceId: 'seed', custom: false })));
    await putExercise({ id: 'seed-001', createdAt: 0, updatedAt: 5, deviceId: 'me', name: 'Мой жим', muscle: 'chest', equipment: 'Штанга', custom: false });
    await db.exercises.put({ id: 'mine', createdAt: 1, updatedAt: 1, deviceId: 'me', name: 'Жим гантелей лёжа', muscle: 'chest', equipment: 'Гантели', custom: true });
    const changesBefore = await db.changes.count();

    await ensureSeeds();

    const all = await db.exercises.toArray();
    expect(all.filter((e) => !e.custom)).toHaveLength(52);
    expect((await db.exercises.get('seed-001'))!.name).toBe('Мой жим');
    expect((await db.exercises.get('mine'))!.custom).toBe(true);
    expect((await db.exercises.get('seed-033'))).toMatchObject({ name: 'Жим гантелей лёжа', updatedAt: 0, deviceId: 'seed', custom: false });
    expect(await db.changes.count()).toBe(changesBefore); // новые стартовые не попадают в журнал синхронизации: они одинаковы на каждом устройстве
    await ensureSeeds(); // повторный запуск ничего не меняет
    expect(await db.exercises.count()).toBe(53);
  });
});
