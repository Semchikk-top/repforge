import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { deleteTemplate, loadTemplates, MAX_TEMPLATES, sanitizeTemplates, saveTemplate, TEMPLATES_KEY } from '../../src/cardio/intervalTemplates';
import { lengthFromInput, lengthToInput } from '../../src/cardio/intervals';
import type { IntervalPlan } from '../../src/domain/types';

const plan: IntervalPlan = { reps: 4, work: { length: { by: 'time', sec: 60 } }, rest: { length: { by: 'time', sec: 30 } } };

describe('ввод длины', () => {
  it('минуты, секунды, метры, километры; запятая и граничные значения', () => {
    expect(lengthFromInput('1,5', 'min')).toEqual({ by: 'time', sec: 90 });
    expect(lengthFromInput('45', 'sec')).toEqual({ by: 'time', sec: 45 });
    expect(lengthFromInput('400', 'm')).toEqual({ by: 'distance', m: 400 });
    expect(lengthFromInput('1.2', 'km')).toEqual({ by: 'distance', m: 1200 });
    expect(lengthFromInput('4', 'sec')).toBeNull();
    expect(lengthFromInput('19', 'm')).toBeNull();
    expect(lengthFromInput('', 'min')).toBeNull();
    expect(lengthFromInput('abc', 'min')).toBeNull();
    expect(lengthFromInput('-5', 'min')).toBeNull();
  });
  it('обратное преобразование для редактирования шаблона', () => {
    for (const l of [{ by: 'time', sec: 90 }, { by: 'time', sec: 45 }, { by: 'time', sec: 300 }, { by: 'distance', m: 400 }, { by: 'distance', m: 2000 }] as const) {
      const f = lengthToInput(l);
      expect(lengthFromInput(f.text, f.unit)).toEqual(l);
    }
  });
});

describe('шаблоны в kv', () => {
  beforeEach(async () => { await db.kv.delete(TEMPLATES_KEY); });

  it('сохраняет, читает и удаляет; то же название у того же вида заменяет старый', async () => {
    expect(await saveTemplate('  4×1 мин ', 'run', plan)).toBeNull();
    expect(await saveTemplate('4×1 мин', 'run', { ...plan, reps: 5 })).toBeNull();
    expect(await saveTemplate('4×1 мин', 'bike', plan)).toBeNull();
    const all = await loadTemplates();
    expect(all).toHaveLength(2);
    expect(all.find((t) => t.sport === 'run')!.plan.reps).toBe(5);
    await deleteTemplate(all[0].id);
    expect(await loadTemplates()).toHaveLength(1);
  });

  it('пустое название и неверный план отвергаются', async () => {
    expect(await saveTemplate('  ', 'run', plan)).not.toBeNull();
    expect(await saveTemplate('х', 'run', { ...plan, reps: 0 })).not.toBeNull();
    expect(await loadTemplates()).toEqual([]);
  });

  it('больше 20 шаблонов не сохраняется', async () => {
    for (let i = 0; i < MAX_TEMPLATES; i++) expect(await saveTemplate('t' + i, 'run', plan)).toBeNull();
    expect(await saveTemplate('лишний', 'run', plan)).toContain('20');
  });

  it('испорченные записи в хранилище пропускаются, а не ломают список', async () => {
    await db.kv.put({ key: TEMPLATES_KEY, value: [null, 5, { id: 'a', title: 'ok', sport: 'run', plan }, { id: 'b', title: 'bad', sport: 'run', plan: { reps: 99 } }, { id: 'c', title: '', sport: 'run', plan }] });
    expect((await loadTemplates()).map((t) => t.id)).toEqual(['a']);
    expect(sanitizeTemplates('мусор')).toEqual([]);
  });
});
