import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { ensureSeeds, putExercise, putTemplate, putWorkout } from '../../src/db/repo';
import { forecastSec } from '../../src/domain/forecast';
import { fieldToRest, formatRest, ownRestSec, resolveRest, restToField } from '../../src/domain/rest';
import { lastRest, restByWorkout, suggestRestChange } from '../../src/domain/restHints';
import { workoutsToCsv, workSecCell } from '../../src/domain/exportData';
import { toCSV } from '../../src/db/exporters';
import {
  addToDraft, applyDraft, cleanGroups, draftOf, draftValid, isDirty, moveInDraft, patchInDraft, programsUsing, removeFromDraft, renameDraft, stepInDraft
} from '../../src/domain/templateEdit';
import type { Exercise, Program, SetEntry, Template, TemplateExercise, Workout, WorkoutExercise } from '../../src/domain/types';

const ex = (over: Partial<Exercise> = {}): Exercise => ({ id: 'e', name: 'Жим', muscle: 'chest', equipment: 'Штанга', custom: true, createdAt: 1, updatedAt: 1, deviceId: 'd', ...over });

// ---------- RF-001 ----------
describe('RF-001: отдых по упражнению', () => {
  it('отдых упражнения важнее общей настройки, без него берётся настройка', () => {
    expect(resolveRest(ex({ restSec: 150 }), 90)).toEqual({ sec: 150, source: 'exercise' });
    expect(resolveRest(ex(), 90)).toEqual({ sec: 90, source: 'settings' });
    expect(resolveRest(undefined, 75)).toEqual({ sec: 75, source: 'settings' });
  });

  it('старые и испорченные данные работают как «не задано»', () => {
    for (const bad of [0, -30, NaN, Infinity, 2, 99999]) expect(resolveRest(ex({ restSec: bad }), 90).source).toBe('settings');
    expect(ownRestSec(ex({ restSec: 60.4 }))).toBe(60);
  });

  it('поле редактора: пусто — как в настройках, мусор не сохраняется', () => {
    expect(fieldToRest('')).toBeUndefined();
    expect(fieldToRest('120')).toBe(120);
    expect(fieldToRest('abc')).toBeUndefined();
    expect(restToField(undefined)).toBe('');
    expect(restToField(180)).toBe('180');
    expect(formatRest(90)).toBe('1:30');
    expect(formatRest(30)).toBe('0:30');
  });

  it('прогноз длительности учитывает отдых каждого упражнения', () => {
    const set = (id: string): SetEntry => ({ id, weight: 10, reps: 10, done: false });
    const a: WorkoutExercise = { id: 'a', exerciseId: 'ea', sets: [set('1'), set('2')] };
    const b: WorkoutExercise = { id: 'b', exerciseId: 'eb', sets: [set('3'), set('4')] };
    const rest = (we: WorkoutExercise) => (we.id === 'a' ? 60 : 180);
    // 4 подхода по 40 с; отдых после 1-го (60), 2-го (60), 3-го (180); после последнего отдыха нет
    expect(forecastSec([a, b], [], 90, undefined, rest)!.sec).toBe(4 * 40 + 60 + 60 + 180);
    // без функции — прежнее поведение: везде общий отдых
    expect(forecastSec([a, b], [], 90)!.sec).toBe(4 * 40 + 3 * 90);
  });

  it('значение хранится в упражнении и уходит в журнал синхронизации', async () => {
    await Promise.all([db.exercises.clear(), db.changes.clear()]);
    const saved = await putExercise(ex({ id: 'x1', restSec: 120 }));
    expect((await db.exercises.get('x1'))!.restSec).toBe(120);
    expect(saved.updatedAt).toBeGreaterThan(1);
    expect((await db.changes.toArray()).some((c) => c.table === 'exercises' && c.entityId === 'x1' && c.op === 'put')).toBe(true);
    // без значения поле просто отсутствует: старые записи не требуют миграции
    await putExercise(ex({ id: 'x2' }));
    expect('restSec' in (await db.exercises.get('x2'))! && (await db.exercises.get('x2'))!.restSec !== undefined).toBe(false);
  });
});

// ---------- RF-004 ----------
const mkSet = (id: string, over: Partial<SetEntry> = {}): SetEntry => ({ id, weight: 50, reps: 10, done: true, ...over });
/** Тренировка, где в упражнении «bench» отдых между подходами был rest секунд (подходов n). */
function wkRest(id: string, day: number, rest: number, n = 3, exerciseId = 'bench'): Workout {
  const sets: SetEntry[] = [];
  let t = 1_000_000 * day;
  for (let i = 0; i < n; i++) {
    const workSec = 30;
    // отдых между галочками: начало подхода = галочка предыдущего + отдых, галочка = начало + workSec
    t = i === 0 ? t : t + (rest + workSec) * 1000;
    sets.push(mkSet(`${id}-${i}`, { completedAt: t, workSec: i === 0 ? undefined : workSec }));
  }
  return { id, date: `2026-10-${String(day).padStart(2, '0')}`, title: 'T', status: 'done', finishedAt: t + 1, exercises: [{ id: id + 'w', exerciseId, sets }], createdAt: 1, updatedAt: 1, deviceId: 'd' };
}

describe('RF-004: подсказки по отдыху', () => {
  it('«в прошлый раз» — средний отдых упражнения в последней тренировке с измерением', () => {
    const hist = [wkRest('a', 1, 100), wkRest('b', 3, 130), wkRest('c', 5, 60, 3, 'squat')];
    expect(lastRest(hist, 'bench')!.avgSec).toBeCloseTo(130, 5);
    expect(lastRest(hist, 'squat')!.avgSec).toBeCloseTo(60, 5);
    expect(lastRest(hist, 'none')).toBeNull();
    expect(lastRest(hist, 'bench', 'b')!.avgSec).toBeCloseTo(100, 5); // текущая тренировка исключается
    expect(restByWorkout(hist, 'bench').map((x) => x.workoutId)).toEqual(['a', 'b']);
  });

  it('предложение появляется только после трёх тренировок подряд с одним отклонением', () => {
    const long2 = [wkRest('a', 1, 150), wkRest('b', 2, 150)];
    expect(suggestRestChange(long2, 'bench', 90)).toBeNull(); // на первых тренировках — нет
    const long3 = [...long2, wkRest('c', 3, 160)];
    const s = suggestRestChange(long3, 'bench', 90)!;
    expect(s.direction).toBe('longer');
    expect(s.sec).toBe(150);
    expect(s.sec % 15).toBe(0);
    const short3 = [wkRest('a', 1, 40), wkRest('b', 2, 45), wkRest('c', 3, 50)];
    expect(suggestRestChange(short3, 'bench', 90)).toMatchObject({ direction: 'shorter', sec: 45 });
  });

  it('нет предложения, если отдых то длиннее, то короче, или близок к настроенному', () => {
    expect(suggestRestChange([wkRest('a', 1, 150), wkRest('b', 2, 60), wkRest('c', 3, 160)], 'bench', 90)).toBeNull();
    expect(suggestRestChange([wkRest('a', 1, 95), wkRest('b', 2, 100), wkRest('c', 3, 85)], 'bench', 90)).toBeNull();
  });

  it('учитывает только то же упражнение и не меняет ничего сам', () => {
    const hist = [wkRest('a', 1, 150), wkRest('b', 2, 150, 3, 'squat'), wkRest('c', 3, 150), wkRest('d', 4, 150, 3, 'squat')];
    expect(suggestRestChange(hist, 'bench', 90)).toBeNull(); // у жима только две тренировки
    const before = JSON.stringify(hist);
    suggestRestChange(hist, 'squat', 90);
    expect(JSON.stringify(hist)).toBe(before);
  });

  it('после «Не сейчас» предложение возвращается, только когда накопятся три новые тренировки', () => {
    const base = [wkRest('a', 1, 150), wkRest('b', 2, 150), wkRest('c', 3, 150)];
    const dismissedAt = Math.max(...base.map((w) => w.finishedAt!)) + 10;
    expect(suggestRestChange(base, 'bench', 90, { dismissedAfter: dismissedAt })).toBeNull();
    const more = [...base, wkRest('d', 10, 150), wkRest('e', 11, 150)];
    expect(suggestRestChange(more, 'bench', 90, { dismissedAfter: dismissedAt })).toBeNull(); // новых пока две
    expect(suggestRestChange([...more, wkRest('f', 12, 150)], 'bench', 90, { dismissedAfter: dismissedAt })).not.toBeNull();
  });
});

// ---------- RF-005 ----------
describe('RF-005: время подхода в CSV', () => {
  const exMap = new Map([['bench', ex({ id: 'bench' })]]);
  const w = (sets: SetEntry[]): Workout => ({ id: 'w', date: '2026-10-20', title: 'Т', status: 'done', exercises: [{ id: 'we', exerciseId: 'bench', sets }], createdAt: 1, updatedAt: 1, deviceId: 'd' });

  it('в заголовке есть колонка, а значение стоит у нужного подхода', () => {
    const csv = workoutsToCsv([w([mkSet('1', { workSec: 42 }), mkSet('2')])], exMap);
    const [head, r1, r2] = csv.split('\r\n');
    expect(head.endsWith(';Время подхода, с')).toBe(true);
    expect(head.split(';')).toHaveLength(12);
    expect(r1.split(';')).toHaveLength(12);
    expect(r1.endsWith(';42')).toBe(true);
    expect(r2.endsWith(';')).toBe(true); // старый подход без значения: пустая ячейка, строка не ломается
  });

  it('строка кардио тоже имеет все колонки', () => {
    const cardio: Workout = { ...w([]), exercises: [{ id: 'we', exerciseId: 'bench', sets: [], cardio: { source: 'manual', distanceM: 5000, durationSec: 1500 } }] };
    const row = workoutsToCsv([cardio], exMap).split('\r\n')[1];
    expect(row.split(';')).toHaveLength(12);
    expect(row).toContain(';5.00;1500;');
  });

  it('значение — только число; заметки с формулами по-прежнему обезврежены', () => {
    expect(workSecCell(42.4)).toBe('42');
    expect(workSecCell(undefined)).toBe('');
    expect(workSecCell(NaN)).toBe('');
    expect(workSecCell('=1+1')).toBe('');
    expect(workoutsToCsv([w([mkSet('1', { note: '=1+1', workSec: 5 })])], exMap)).toContain("'=1+1");
  });

  it('таблица подходов (английские заголовки) тоже получает колонку', () => {
    const csv = toCSV([w([mkSet('1', { workSec: 33 })])], exMap).split('\n');
    expect(csv[0].endsWith(',work_sec')).toBe(true);
    expect(csv[1].endsWith(',33')).toBe(true);
  });
});

// ---------- RF-002 ----------
const te = (exerciseId: string, over: Partial<TemplateExercise> = {}): TemplateExercise => ({ exerciseId, sets: 3, reps: 10, weight: 50, ...over });
const tpl = (exercises: TemplateExercise[], title = 'Грудь'): Template => ({ id: 't', title, exercises, createdAt: 1, updatedAt: 1, deviceId: 'd' });
const ids = (xs: TemplateExercise[]) => xs.map((x) => x.exerciseId).join('');

describe('RF-002: редактор шаблонов', () => {
  it('черновик — копия: правки не трогают исходный шаблон (отмена)', () => {
    const t = tpl([te('a'), te('b')]);
    const d = patchInDraft(removeFromDraft(renameDraft(draftOf(t), 'Другое'), 0), 0, { sets: 5 });
    expect(t.title).toBe('Грудь');
    expect(t.exercises).toHaveLength(2);
    expect(t.exercises[0].sets).toBe(3);
    expect(isDirty(t, draftOf(t))).toBe(false);
    expect(isDirty(t, d)).toBe(true);
  });

  it('переименование, добавление и удаление', () => {
    let d = draftOf(tpl([te('a')]));
    d = addToDraft(d, 'b');
    d = addToDraft(d, 'run', true);
    expect(ids(d.exercises)).toBe('abrun');
    expect(d.exercises[1]).toMatchObject({ sets: 3, reps: 10, weight: 0 });
    expect(d.exercises[2].sets).toBe(1);
    d = removeFromDraft(d, 1);
    expect(ids(d.exercises)).toBe('arun');
    expect(removeFromDraft(d, 99)).toBe(d);
    expect(draftValid(renameDraft(d, '  '))).toBe(false);
    expect(draftValid({ title: 'X', exercises: [] })).toBe(false);
  });

  it('порядок: перемещение сохраняется, суперсет двигается целиком и не разрывается', () => {
    const d = draftOf(tpl([te('a'), te('b', { group: 'g' }), te('c', { group: 'g' }), te('d')]));
    const down = stepInDraft(d, 0, 1);
    expect(ids(down.exercises)).toBe('bcad');
    expect(down.exercises[0].group).toBe(down.exercises[1].group);
    expect(ids(stepInDraft(d, 2, -1).exercises)).toBe('bcad'); // любое упражнение связки двигает всю связку
    expect(stepInDraft(d, 0, -1)).toBe(d);
    expect(ids(moveInDraft(d, 0, 2).exercises)).toBe('bcda');
  });

  it('удаление из связки не оставляет «связку из одного»', () => {
    const d = removeFromDraft(draftOf(tpl([te('a', { group: 'g' }), te('b', { group: 'g' }), te('c')])), 0);
    expect(d.exercises[0].group).toBeUndefined();
    expect(cleanGroups([te('a', { group: 'x' })])[0].group).toBeUndefined();
  });

  it('подходы, повторы и вес ограничены разумными границами', () => {
    const d = draftOf(tpl([te('a')]));
    expect(patchInDraft(d, 0, { sets: 0 }).exercises[0].sets).toBe(1);
    expect(patchInDraft(d, 0, { sets: 99 }).exercises[0].sets).toBe(20);
    expect(patchInDraft(d, 0, { reps: -4 }).exercises[0].reps).toBe(1);
    expect(patchInDraft(d, 0, { weight: -5 }).exercises[0].weight).toBe(0);
    expect(patchInDraft(d, 0, { weight: 62.5 }).exercises[0].weight).toBe(62.5);
    expect(patchInDraft(d, 0, { sets: NaN }).exercises[0].sets).toBe(3);
    expect(patchInDraft(d, 5, { sets: 4 })).toBe(d);
  });

  it('применение черновика: id и даты те же, название обрезано, связки приведены в порядок', () => {
    const t = tpl([te('a'), te('b')]);
    const out = applyDraft(t, { title: '  Новое имя  ', exercises: [te('a', { group: 'solo' }), te('b', { reps: 8 })] });
    expect(out).toMatchObject({ id: 't', createdAt: 1, title: 'Новое имя' });
    expect(out.exercises[0].group).toBeUndefined();
    expect(out.exercises[1].reps).toBe(8);
  });

  it('предупреждение: какие программы используют шаблон', () => {
    const p = (id: string, templateId: string, over: Partial<Program> = {}): Program => ({ id, title: id, startDate: '2026-11-02', weeks: 4, days: [{ weekday: 1, templateId }], createdAt: 1, updatedAt: 1, deviceId: 'd', ...over });
    const list = [p('p1', 't'), p('p2', 'other'), p('p3', 't', { archivedAt: 5 }), p('p4', 't', { deletedAt: 5 })];
    expect(programsUsing(list, 't').map((x) => x.id)).toEqual(['p1']);
  });

  it('сохранение в базе не ломает уже созданные тренировки', async () => {
    await Promise.all([db.exercises.clear(), db.templates.clear(), db.workouts.clear(), db.changes.clear()]);
    await ensureSeeds();
    const t = tpl([te('a'), te('b')]);
    await putTemplate(t);
    const workout: Workout = { id: 'w1', date: '2026-11-01', title: 'Грудь', status: 'planned', templateId: 't', exercises: [{ id: 'we1', exerciseId: 'a', sets: [mkSet('s1', { done: false })] }], createdAt: 1, updatedAt: 1, deviceId: 'd' };
    await putWorkout(workout);
    const before = JSON.stringify(await db.workouts.get('w1'));
    await putTemplate(applyDraft(t, patchInDraft(removeFromDraft(renameDraft(draftOf(t), 'Новое'), 0), 0, { sets: 6 })));
    expect(JSON.stringify(await db.workouts.get('w1'))).toBe(before);
    const saved = (await db.templates.get('t'))!;
    expect(saved.title).toBe('Новое');
    expect(saved.exercises).toHaveLength(1);
    expect(saved.createdAt).toBe(1);
    expect((await db.changes.toArray()).some((c) => c.table === 'templates' && c.entityId === 't')).toBe(true);
  });
});
