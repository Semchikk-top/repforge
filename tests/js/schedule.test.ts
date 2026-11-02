import { describe, expect, it } from 'vitest';
import {
  DAYS, assignmentFromProgram, normalizeAssignment, planWeek, scoreAssignment,
  type Assignment, type Busy, type Day, type PlanTemplate
} from '../../src/domain/schedule';

const T = (id: string, heavy = false): PlanTemplate => ({ id, heavy });
const light3 = [T('T1'), T('T2'), T('T3')];
const MWF = { mon: 'T1', wed: 'T2', fri: 'T3' } as const;
const MWS = { mon: 'T1', wed: 'T2', sat: 'T3' } as const;
const busyOf = (...days: Day[]): Busy => Object.fromEntries(days.map((d) => [d, true]));
const placedIds = (a: Assignment) => DAYS.map((d) => a[d]).filter(Boolean) as string[];

describe('планирование недели: когда менять нечего', () => {
  it('если занятые дни не мешают, план возвращается как есть', () => {
    const r = planWeek(light3, busyOf('tue', 'thu'), MWF);
    expect(r.assignment).toEqual(normalizeAssignment(MWF));
    expect(r.changed).toBe(false);
    expect(r.feasible).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('исходный план с «подряд» не переписывается без причины', () => {
    const r = planWeek(light3, {}, { mon: 'T1', tue: 'T2', thu: 'T3' });
    expect(r.changed).toBe(false);
    expect(r.hasAdjacent).toBe(true);
  });

  it('воскресенье занято — не влияет: окно пн–сб', () => {
    const r = planWeek(light3, {}, MWF);
    expect(r.changed).toBe(false);
  });
});

describe('планирование недели: перестановка при занятых днях', () => {
  it('пн занят в пн/ср/пт: единственный вариант без подряд — вт/чт/сб, порядок сохранён', () => {
    const r = planWeek(light3, busyOf('mon'), MWF);
    expect(r.assignment).toEqual({ mon: null, tue: 'T1', wed: null, thu: 'T2', fri: null, sat: 'T3' });
    expect(r.hasAdjacent).toBe(false);
    expect(r.changed).toBe(true);
  });

  it('ср занята в пн/ср/сб: переезжает только одна тренировка', () => {
    const r = planWeek(light3, busyOf('wed'), MWS);
    expect(r.assignment).toEqual({ mon: 'T1', tue: null, wed: null, thu: 'T2', fri: null, sat: 'T3' });
    // перенос одной тренировки стоит один раз, а не два
    expect(r.score).toBe(10);
  });

  it('занятый день никогда не получает тренировку', () => {
    const busy = busyOf('mon', 'wed');
    const r = planWeek(light3, busy, MWF);
    for (const d of DAYS) if (busy[d]) expect(r.assignment[d]).toBeNull();
  });

  it('сб → вс → пн не считается подряд', () => {
    const two = [T('T1'), T('T2')];
    const r = planWeek(two, busyOf('tue', 'wed', 'thu', 'fri'), { tue: 'T1', thu: 'T2' });
    expect(r.assignment).toEqual({ mon: 'T1', tue: null, wed: null, thu: null, fri: null, sat: 'T2' });
    expect(r.hasAdjacent).toBe(false);
  });
});

describe('планирование недели: подряд — штраф, а не запрет', () => {
  // свободны только вт, ср, чт: подряд неизбежно
  const busy = busyOf('mon', 'fri', 'sat');

  it('возвращает вариант с подряд и объясняет, почему иначе нельзя', () => {
    const r = planWeek(light3, busy, MWF);
    expect(r.feasible).toBe(true);
    expect(r.hasAdjacent).toBe(true);
    expect(r.warnings.some((w) => w.startsWith('Тренировки подряд'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('альтернатив нет'))).toBe(true);
  });

  it('две тяжёлые подряд хуже, чем тяжёлая и лёгкая: тяжёлые уходят на края цепочки', () => {
    const tpl = [T('T1'), T('T2', true), T('T3', true)];
    const r = planWeek(tpl, busy, MWF);
    expect(r.assignment.wed).toBe('T1');
    expect(r.warnings.every((w) => !w.startsWith('Тяжёлые'))).toBe(true);
  });

  it('если развести тяжёлые нельзя, предупреждение называет именно тяжёлые', () => {
    const tpl = [T('T1', true), T('T2', true), T('T3', true)];
    const r = planWeek(tpl, busy, MWF);
    expect(r.warnings.filter((w) => w.startsWith('Тяжёлые тренировки подряд'))).toHaveLength(2);
  });

  it('порядок шаблонов сохраняется, если это ничего не стоит', () => {
    const r = planWeek(light3, busy, MWF);
    expect(r.assignment).toEqual({ mon: null, tue: 'T1', wed: 'T2', thu: 'T3', fri: null, sat: null });
  });
});

describe('планирование недели: свободных дней не хватает', () => {
  it('меньше свободных дней, чем тренировок: Infinity и предложение сократить неделю', () => {
    const r = planWeek(light3, busyOf('mon', 'tue', 'wed', 'thu'), MWF);
    expect(r.feasible).toBe(false);
    expect(r.score).toBe(Infinity);
    expect(r.capacity).toBe(2);
    expect(placedIds(r.assignment)).toEqual([]);
    expect(r.warnings[0]).toContain('сократить неделю');
  });

  it('сокращённая неделя считается тем же вызовом с меньшим набором шаблонов', () => {
    const r = planWeek([T('T1'), T('T3')], busyOf('mon', 'tue', 'wed', 'thu'), MWF);
    expect(r.feasible).toBe(true);
    expect(placedIds(r.assignment).sort()).toEqual(['T1', 'T3']);
  });

  it('все дни заняты', () => {
    const r = planWeek(light3, busyOf(...DAYS), MWF);
    expect(r.feasible).toBe(false);
    expect(r.warnings[0]).toContain('Все дни недели заняты');
  });
});

describe('планирование недели: свойства', () => {
  it('для каждой комбинации занятых дней: без повторов, без занятых дней, без подряд если возможно', () => {
    for (let mask = 0; mask < 1 << DAYS.length; mask++) {
      const busy: Busy = {};
      DAYS.forEach((d, i) => { if (mask & (1 << i)) busy[d] = true; });
      const free = DAYS.filter((d) => !busy[d]);
      const r = planWeek(light3, busy, MWF);

      if (free.length < 3) { expect(r.feasible).toBe(false); continue; }

      const ids = placedIds(r.assignment);
      expect(ids.sort()).toEqual(['T1', 'T2', 'T3']);
      for (const d of DAYS) if (busy[d]) expect(r.assignment[d]).toBeNull();

      // независимая проверка: существует ли тройка свободных дней без соседних
      const idx = free.map((d) => DAYS.indexOf(d));
      let possible = false;
      for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) for (let c = b + 1; c < idx.length; c++) {
        if (idx[b] - idx[a] > 1 && idx[c] - idx[b] > 1) possible = true;
      }
      expect(r.hasAdjacent).toBe(!possible);
    }
  });

  it('детерминирован и не меняет входные данные', () => {
    const tpl = [T('T1'), T('T2', true), T('T3', true)];
    const busy = busyOf('mon');
    const plan = { ...MWF };
    const snapshot = JSON.stringify({ tpl, busy, plan });
    const a = planWeek(tpl, busy, plan);
    const b = planWeek(tpl, busy, plan);
    expect(a).toEqual(b);
    expect(JSON.stringify({ tpl, busy, plan })).toBe(snapshot);
  });

  it('повторяющиеся id шаблонов — ошибка вызова', () => {
    expect(() => planWeek([T('T1'), T('T1')], {}, {})).toThrow();
  });

  it('штрафы настраиваются: при нулевом штрафе за порядок шаблоны могут меняться местами', () => {
    const tpl = [T('T1'), T('T2', true), T('T3', true)];
    const busy = busyOf('mon', 'fri', 'sat');
    const r = planWeek(tpl, busy, MWF, { penaltyOrder: 0, penaltyHeavyAdjacent: 5000 });
    expect(r.assignment.wed).toBe('T1');
  });
});

describe('scoreAssignment и программа', () => {
  it('оценка готового назначения совпадает с результатом планировщика', () => {
    const r = planWeek(light3, busyOf('mon'), MWF);
    const s = scoreAssignment(r.assignment, MWF, light3);
    expect(s.score).toBe(r.score);
    expect(s.hasAdjacent).toBe(false);
  });

  it('дни программы (1 — пн) переводятся в назначение; воскресенье и дубли уходят в skipped', () => {
    const { assignment, skipped } = assignmentFromProgram([
      { weekday: 1, templateId: 'T1' },
      { weekday: 3, templateId: 'T2' },
      { weekday: 7, templateId: 'T3' },
      { weekday: 3, templateId: 'T4' }
    ]);
    expect(assignment).toEqual({ mon: 'T1', tue: null, wed: 'T2', thu: null, fri: null, sat: null });
    expect(skipped.map((d) => d.templateId)).toEqual(['T3', 'T4']);
  });
});
