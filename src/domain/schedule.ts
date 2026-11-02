// Перестановка шаблонов тренировок внутри недели с учётом занятых дней.
// Чистая функция: без календаря, без натива, без побочных эффектов.
// Описание правил и причин — в SCEDULE_PLAN.md.

import type { ProgramDay } from './types';

/** Окно планирования: пн–сб. Воскресенье — выходной и разрывает цепочку «подряд». */
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Day = (typeof DAYS)[number];

export const DAY_LABEL: Record<Day, string> = { mon: 'Пн', tue: 'Вт', wed: 'Ср', thu: 'Чт', fri: 'Пт', sat: 'Сб' };

/** День → id шаблона или null, если в этот день тренировки нет. Всегда содержит все шесть дней. */
export type Assignment = Record<Day, string | null>;
/** Вход допускает пропущенные дни: они считаются пустыми. */
export type AssignmentInput = Partial<Record<Day, string | null>>;
/** Занят ли день важным событием. Тренировка в такой день не ставится никогда. */
export type Busy = Partial<Record<Day, boolean>>;

export interface PlanTemplate {
  id: string;
  /** Тяжёлая тренировка (силовая с большими весами). */
  heavy: boolean;
  /** Группы мышц: пока не используются, задел под правило «не пересекаться по тяжёлым группам». */
  tags?: string[];
}

export interface Rules {
  /** Штраф за каждую пару тренировок в соседние дни. */
  penaltyAdjacent: number;
  /** Дополнительный штраф, если обе тренировки в такой паре тяжёлые. */
  penaltyHeavyAdjacent: number;
  /** Штраф за каждый шаблон, ушедший со своего дня. */
  penaltyShift: number;
  /** Штраф за каждую пару шаблонов, поменявшихся местами относительно исходного порядка. */
  penaltyOrder: number;
}

export const DEFAULT_RULES: Rules = {
  penaltyAdjacent: 1000,
  penaltyHeavyAdjacent: 500,
  penaltyShift: 10,
  penaltyOrder: 30
};

export interface PlanResult {
  assignment: Assignment;
  /** Человекочитаемые предупреждения для карточки предложения. */
  warnings: string[];
  /** Итоговый штраф (для отладки). Infinity, если расставить нельзя. */
  score: number;
  hasAdjacent: boolean;
  /** Удалось ли расставить все шаблоны. false — свободных дней меньше, чем тренировок. */
  feasible: boolean;
  /** Отличается ли результат от исходного плана: если нет, карточку предлагать не нужно. */
  changed: boolean;
  /** Сколько тренировок в неделе вообще помещается (число свободных дней). */
  capacity: number;
}

const emptyAssignment = (): Assignment => ({ mon: null, tue: null, wed: null, thu: null, fri: null, sat: null });

export function normalizeAssignment(a: AssignmentInput = {}): Assignment {
  const out = emptyAssignment();
  for (const d of DAYS) out[d] = a[d] ?? null;
  return out;
}

const sameAssignment = (a: Assignment, b: Assignment) => DAYS.every((d) => a[d] === b[d]);

/** Программа хранит дни как 1 — пн … 7 — вс. Воскресенье в окно не входит, такие дни возвращаются отдельно. */
export function assignmentFromProgram(days: ProgramDay[]): { assignment: Assignment; skipped: ProgramDay[] } {
  const assignment = emptyAssignment();
  const skipped: ProgramDay[] = [];
  for (const d of days) {
    const day = DAYS[d.weekday - 1];
    if (!day || assignment[day]) skipped.push(d);
    else assignment[day] = d.templateId;
  }
  return { assignment, skipped };
}

interface Analysis {
  score: number;
  moved: number;
  pairs: { a: Day; b: Day; heavy: boolean }[];
}

function analyze(assignment: Assignment, original: Assignment, byId: Map<string, PlanTemplate>, rules: Rules): Analysis {
  let score = 0;

  // Подряд и тяжёлые подряд. Соседство только внутри пн–сб: сб → вс → пн подряд не считается.
  const pairs: Analysis['pairs'] = [];
  for (let i = 0; i < DAYS.length - 1; i++) {
    const a = assignment[DAYS[i]];
    const b = assignment[DAYS[i + 1]];
    if (!a || !b) continue;
    const heavy = !!(byId.get(a)?.heavy && byId.get(b)?.heavy);
    pairs.push({ a: DAYS[i], b: DAYS[i + 1], heavy });
    score += rules.penaltyAdjacent + (heavy ? rules.penaltyHeavyAdjacent : 0);
  }

  // Позиции шаблонов в новом и исходном плане. Считаем по шаблонам, а не по дням:
  // перенос одной тренировки стоит один раз, а не два (день, откуда ушла, и день, куда пришла).
  const posNew = new Map<string, number>();
  const posOld = new Map<string, number>();
  DAYS.forEach((d, i) => {
    const n = assignment[d];
    const o = original[d];
    if (n) posNew.set(n, i);
    if (o) posOld.set(o, i);
  });

  let moved = 0;
  const both: string[] = [];
  for (const [id, i] of posNew) {
    const j = posOld.get(id);
    if (j === undefined) continue; // шаблона не было в плане: сравнивать не с чем
    both.push(id);
    if (i !== j) moved++;
  }
  score += moved * rules.penaltyShift;

  // Инверсии порядка: шаблоны, которые поменялись местами относительно исходного плана.
  for (let x = 0; x < both.length; x++) {
    for (let y = x + 1; y < both.length; y++) {
      const a = both[x];
      const b = both[y];
      if ((posOld.get(a)! - posOld.get(b)!) * (posNew.get(a)! - posNew.get(b)!) < 0) score += rules.penaltyOrder;
    }
  }

  return { score, moved, pairs };
}

function warningsFor(pairs: Analysis['pairs']): string[] {
  return pairs.map((p) =>
    p.heavy
      ? `Тяжёлые тренировки подряд: ${DAY_LABEL[p.a]} и ${DAY_LABEL[p.b]}`
      : `Тренировки подряд: ${DAY_LABEL[p.a]} и ${DAY_LABEL[p.b]}`
  );
}

/** Оценка готового назначения: штраф, наличие «подряд» и предупреждения. */
export function scoreAssignment(
  assignment: AssignmentInput,
  originalPlan: AssignmentInput,
  templates: PlanTemplate[],
  rules: Partial<Rules> = {}
): { score: number; hasAdjacent: boolean; warnings: string[] } {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const r = analyze(normalizeAssignment(assignment), normalizeAssignment(originalPlan), byId, { ...DEFAULT_RULES, ...rules });
  return { score: r.score, hasAdjacent: r.pairs.length > 0, warnings: warningsFor(r.pairs) };
}

function* combinations<T>(items: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) { yield [...acc]; return; }
  for (let i = start; i <= items.length - (k - acc.length); i++) {
    acc.push(items[i]);
    yield* combinations(items, k, i + 1, acc);
    acc.pop();
  }
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) { yield [...items]; return; }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

const keyOf = (a: Assignment) => DAYS.map((d) => a[d] ?? '').join('|');

/**
 * Расставить шаблоны недели по свободным дням.
 *
 * Жёсткие правила обеспечиваются построением: шаблон не повторяется и никогда не попадает на занятый день.
 * Остальное (подряд, тяжёлые подряд, смещение, порядок) — штрафы. Полный перебор: максимум 720 вариантов.
 * Если ни одна тренировка не стоит на занятом дне, план возвращается как есть: меняем только то, что вынуждены.
 * Чтобы сократить неделю, вызови функцию с меньшим набором шаблонов: исходный план нужен только для штрафов.
 */
export function planWeek(
  templates: PlanTemplate[],
  busy: Busy = {},
  originalPlan: AssignmentInput = {},
  rulesIn: Partial<Rules> = {}
): PlanResult {
  const rules = { ...DEFAULT_RULES, ...rulesIn };
  const ids = new Set(templates.map((t) => t.id));
  if (ids.size !== templates.length) throw new Error('planWeek: id шаблонов должны быть уникальны');

  const original = normalizeAssignment(originalPlan);
  const byId = new Map(templates.map((t) => [t.id, t]));
  const freeDays = DAYS.filter((d) => !busy[d]);
  const n = templates.length;

  const finish = (assignment: Assignment, extra: Partial<PlanResult> = {}): PlanResult => {
    const a = analyze(assignment, original, byId, rules);
    return {
      assignment,
      warnings: warningsFor(a.pairs),
      score: a.score,
      hasAdjacent: a.pairs.length > 0,
      feasible: true,
      changed: !sameAssignment(assignment, original),
      capacity: freeDays.length,
      ...extra
    };
  };

  const infeasible = (warning: string): PlanResult => ({
    assignment: emptyAssignment(),
    warnings: [warning],
    score: Infinity,
    hasAdjacent: false,
    feasible: false,
    changed: false,
    capacity: freeDays.length
  });

  if (freeDays.length < n) {
    return infeasible(
      freeDays.length === 0
        ? 'Все дни недели заняты, поставить тренировки некуда.'
        : `Свободных дней ${freeDays.length}, а тренировок ${n}. Предлагаю сократить неделю.`
    );
  }

  // Конфликтов нет: исходный план полностью укладывается в свободные дни, ничего не трогаем.
  const placed = DAYS.map((d) => original[d]).filter((x): x is string => !!x);
  const planFits =
    placed.length === n && placed.every((id) => ids.has(id)) && DAYS.every((d) => !original[d] || !busy[d]);
  if (planFits) return finish(original);

  let best: { a: Assignment; analysis: Analysis; key: string } | null = null;
  let anyNonAdjacent = false;

  for (const daySet of combinations(freeDays, n)) {
    for (const perm of permutations(templates)) {
      const a = emptyAssignment();
      daySet.forEach((d, i) => { a[d] = perm[i].id; });
      const analysis = analyze(a, original, byId, rules);
      if (analysis.pairs.length === 0) anyNonAdjacent = true;
      const key = keyOf(a);
      // Порядок сравнения: штраф, затем меньше перенесённых тренировок, затем лексикографически: результат детерминирован.
      if (
        !best ||
        analysis.score < best.analysis.score ||
        (analysis.score === best.analysis.score &&
          (analysis.moved < best.analysis.moved || (analysis.moved === best.analysis.moved && key < best.key)))
      ) {
        best = { a, analysis, key };
      }
    }
  }

  const result = finish(best!.a);
  if (result.hasAdjacent && !anyNonAdjacent) {
    result.warnings.push(`Без тренировок подряд не получается: свободны ${freeDays.map((d) => DAY_LABEL[d]).join(', ')}. Это нежелательно, но альтернатив нет.`);
  }
  return result;
}
