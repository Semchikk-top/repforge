import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { suggestNext } from '../../src/domain/progression';
import { currentWeek, mondayOf, nextMonday, planProgram, slotKey } from '../../src/domain/programs';
import { csvCell, filterBackup, inRange, workoutsToCsv } from '../../src/domain/exportData';
import { analyzeSplits, decodePoint, elevationProfile, haversine, isSameRoute, resample, routeDistance, segmentSpeeds, speedColor, speedRange, type TrackPoint } from '../../src/cardio/geo';
import { toMultiGpx } from '../../src/cardio/gpx';
import { isConflict, sameContent, stableStringify } from '../../src/sync/conflicts';
import type { Exercise, Program, SetEntry, Template, Workout } from '../../src/domain/types';

const set = (weight: number, reps: number, extra: Partial<SetEntry> = {}): SetEntry => ({ id: Math.random().toString(36).slice(2), weight, reps, done: true, ...extra });
const wk = (id: string, date: string, sets: SetEntry[], exerciseId = 'bench'): Workout =>
  ({ id, date, title: 'T', status: 'done', createdAt: 1, updatedAt: 1, deviceId: 'd', exercises: [{ id: id + 'e', exerciseId, sets }] }) as Workout;

describe('прогрессия: RPE, перерыв, разгрузка', () => {
  it('RPE 9,5+ — не прибавлять', () => {
    const s = suggestNext([wk('1', '2026-10-01', [set(80, 12, { rpe: 10 }), set(80, 12, { rpe: 9.5 })])], 'bench', 2.5)!;
    expect(s).toMatchObject({ kind: 'hold', weight: 80, reps: 12 });
  });
  it('легко (RPE ≤ 7) на верху диапазона — сразу два шага', () => {
    const s = suggestNext([wk('1', '2026-10-01', [set(80, 12, { rpe: 7 }), set(80, 12, { rpe: 6.5 })])], 'bench', 2.5)!;
    expect(s).toMatchObject({ kind: 'add-weight', weight: 85, reps: 8 });
  });
  it('легко, но не на верху диапазона — два повтора', () => {
    expect(suggestNext([wk('1', '2026-10-01', [set(80, 8, { rpe: 6 })])], 'bench', 2.5)).toMatchObject({ kind: 'add-reps', reps: 10 });
  });
  it('без RPE поведение прежнее', () => {
    expect(suggestNext([wk('1', '2026-10-01', [set(80, 8), set(80, 9)])], 'bench', 2.5)).toMatchObject({ weight: 80, reps: 9, kind: 'add-reps' });
    expect(suggestNext([wk('1', '2026-10-01', [set(80, 12), set(80, 13)])], 'bench', 2.5)).toMatchObject({ weight: 82.5, reps: 8, kind: 'add-weight' });
  });
  it('после перерыва больше трёх недель — около 90% веса', () => {
    const h = [wk('1', '2026-09-01', [set(100, 8), set(100, 8)])];
    expect(suggestNext(h, 'bench', 2.5, undefined, new Date('2026-10-20T10:00:00'))).toMatchObject({ kind: 'comeback', weight: 90, reps: 8 });
    expect(suggestNext(h, 'bench', 2.5, undefined, new Date('2026-09-10T10:00:00'))).toMatchObject({ kind: 'add-reps' }); // перерыва нет
    expect(suggestNext(h, 'bench', 2.5)).toMatchObject({ kind: 'add-reps' });                                           // без «сегодня» правило выключено
  });
  it('разгрузка, если повторы падают две тренировки подряд при том же весе', () => {
    const h = [wk('1', '2026-10-01', [set(100, 10)]), wk('2', '2026-10-05', [set(100, 8)]), wk('3', '2026-10-09', [set(100, 6)])];
    expect(suggestNext(h, 'bench', 2.5)).toMatchObject({ kind: 'deload', weight: 90, reps: 10 });
  });
  it('рост веса не считается усталостью', () => {
    const h = [wk('1', '2026-10-01', [set(80, 12)]), wk('2', '2026-10-05', [set(82.5, 8)]), wk('3', '2026-10-09', [set(82.5, 8)])];
    expect(suggestNext(h, 'bench', 2.5)!.kind).toBe('add-reps');
  });
  it('дроп-сеты не влияют ни на вес, ни на RPE', () => {
    const h = [wk('1', '2026-10-01', [set(80, 12, { rpe: 7 }), set(50, 20, { kind: 'drop', rpe: 10 })])];
    expect(suggestNext(h, 'bench', 2.5)).toMatchObject({ kind: 'add-weight', weight: 85 });
  });
});

describe('программы', () => {
  const ex = (id: string) => ({ id, name: id, muscle: 'chest' }) as Exercise;
  const exMap = new Map([['a', ex('a')]]);
  const tpl = { id: 't1', title: 'Грудь', exercises: [{ exerciseId: 'a', sets: 3, reps: 10, weight: 50 }] } as Template;
  const program = { id: 'p1', title: 'Цикл', startDate: '2026-11-02', weeks: 2, days: [{ weekday: 1, templateId: 't1' }, { weekday: 4, templateId: 't1' }, { weekday: 6, templateId: 'gone' }] } as Program;

  it('понедельники и ближайший понедельник', () => {
    expect(nextMonday(new Date('2026-10-25T12:00:00'))).toBe('2026-10-26'); // воскресенье → завтра
    expect(nextMonday(new Date('2026-10-26T12:00:00'))).toBe('2026-10-26'); // понедельник → сегодня
    expect(mondayOf('2026-11-05').getDate()).toBe(2);
  });
  it('назначает тренировки по неделям и пропускает удалённые шаблоны', () => {
    const { slots, missingTemplates } = planProgram({ program, templates: new Map([['t1', tpl]]), existing: [], history: [], exMap, today: '2026-10-30' });
    expect(slots.map((s) => s.date)).toEqual(['2026-11-02', '2026-11-05', '2026-11-09', '2026-11-12']);
    expect(slots[0].programSlot).toBe(slotKey('p1', 0, 1));
    expect(slots[0].exercises[0].sets).toHaveLength(3);
    expect(missingTemplates).toBe(2);
  });
  it('повторный вызов не создаёт дубликатов, прошедшие даты пропускает', () => {
    const first = planProgram({ program, templates: new Map([['t1', tpl]]), existing: [], history: [], exMap, today: '2026-11-04' });
    expect(first.skippedPast).toBe(1);
    const existing = first.slots.map((s, i) => ({ id: 'w' + i, date: s.date, programSlot: s.programSlot }) as Workout);
    expect(planProgram({ program, templates: new Map([['t1', tpl]]), existing, history: [], exMap, today: '2026-11-04' }).slots).toHaveLength(0);
  });
  it('номер недели', () => {
    expect(currentWeek(program, '2026-11-10')).toBe(2);
    expect(currentWeek(program, '2026-10-30')).toBeNull();
    expect(currentWeek(program, '2026-11-20')).toBeNull();
  });
});

describe('экспорт', () => {
  it('CSV защищён от формул, числа не портятся', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+7 999')).toBe("'+7 999");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('а;б')).toBe('"а;б"');
    expect(csvCell('строка\nвторая')).toBe('"строка\nвторая"');
  });
  it('таблица тренировок за период', () => {
    const exMap = new Map([['bench', { id: 'bench', name: 'Жим', muscle: 'chest' } as Exercise]]);
    const ws = [wk('1', '2026-09-01', [set(80, 8, { rpe: 8, note: '=1+1' })]), wk('2', '2026-10-01', [set(85, 5, { kind: 'drop' })])];
    const csv = workoutsToCsv(ws, exMap, { from: '2026-09-15' });
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(2);
    expect(csv).toContain('2026-10-01;T;Жим;1;дроп-сет;85;5');
    expect(workoutsToCsv(ws, exMap)).toContain("'=1+1");
  });
  it('резервная копия за период: связанные маршруты и замеры тоже', () => {
    const data = { workouts: [{ id: 'a', date: '2026-01-01' }, { id: 'b', date: '2026-10-01' }], tracks: [{ workoutId: 'a' }, { workoutId: 'b' }], body: [{ date: '2026-01-02' }, { date: '2026-10-02' }], exercises: [1, 2] };
    const out = filterBackup(data, { from: '2026-06-01' });
    expect(out.workouts).toHaveLength(1); expect(out.tracks).toEqual([{ workoutId: 'b' }]); expect(out.body).toHaveLength(1); expect(out.exercises).toHaveLength(2);
    expect(inRange('2026-05-31', { from: '2026-06-01' })).toBe(false);
  });
});

// маршрут на север со скоростью v, по точке в 5 секунд
const route = (len: number, opts: { lat0?: number; lon0?: number; v?: number; ele?: (i: number) => number | null } = {}): TrackPoint[] => {
  const { lat0 = 55.75, lon0 = 37.6, v = 3, ele = () => null } = opts;
  const n = Math.round(len / (v * 5));
  return Array.from({ length: n + 1 }, (_, i) => { const e = ele(i); return [i * 5, Math.round((lat0 + (i * v * 5) / 111195) * 1e5), Math.round(lon0 * 1e5), e === null ? null : Math.round(e * 10)] as TrackPoint; });
};

describe('анализ темпа и профиль', () => {
  it('негативный сплит и разброс', () => {
    const a = analyzeSplits([340, 335, 330, 320, 315])!;
    expect(a).toMatchObject({ fastest: 5, slowest: 1, trend: 'negative', spreadSec: 25 });
    expect(a.text).toContain('негативный сплит');
  });
  it('ровный темп и «затухание»', () => {
    expect(analyzeSplits([330, 332, 331, 329])!.trend).toBe('even');
    expect(analyzeSplits([300, 305, 330, 345])!.text).toContain('вторая половина медленнее');
    expect(analyzeSplits([330])).toBeNull();
  });
  it('профиль высоты: набор и спуск, шум не считается', () => {
    const hill = elevationProfile(route(3000, { ele: (i) => 100 + Math.sin((i / 200) * Math.PI) * 40 }))!;
    expect(hill.max - hill.min).toBeGreaterThan(30);
    expect(hill.gain).toBeGreaterThan(25); expect(hill.loss).toBeGreaterThan(25);
    expect(elevationProfile(route(3000, { ele: (i) => 100 + (i % 2 ? 0.4 : -0.4) }))).toBeNull(); // ровно
    expect(elevationProfile(route(3000))).toBeNull();                                          // высоты нет
  });
  it('скорости по отрезкам и цвет', () => {
    const pts = route(300).map(decodePoint);
    const sp = segmentSpeeds(pts);
    expect(sp.every((v) => Math.abs(v - 3) < 0.15)).toBe(true);
    const [lo, hi] = speedRange([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(speedColor(lo, lo, hi)).not.toBe(speedColor(hi, lo, hi));
    expect(speedColor(5, 5, 5)).toMatch(/^hsl\(/);
  });
});

describe('сравнение маршрутов', () => {
  const base = route(2000).map(decodePoint);
  it('тот же маршрут, даже со сдвигом на 15 м и в обратную сторону', () => {
    const shifted = route(2000, { lon0: 37.6 + 15 / 62000 }).map(decodePoint);
    expect(isSameRoute(base, shifted)).toBe(true);
    expect(isSameRoute(base, [...shifted].reverse())).toBe(true);
  });
  it('другая форма, другая длина и другое место — разные маршруты', () => {
    expect(isSameRoute(base, route(2000, { lon0: 37.6 + 400 / 62000 }).map(decodePoint))).toBe(false); // параллельный, в 400 м
    expect(isSameRoute(base, route(3000).map(decodePoint))).toBe(false);                               // длиннее на 50%
    expect(isSameRoute(base, route(2000, { lat0: 56.5 }).map(decodePoint))).toBe(false);               // в другом городе
    expect(isSameRoute(base.slice(0, 2), base)).toBe(false);
  });
  it('resample даёт равномерные точки', () => {
    const r = resample(base, 11);
    expect(r).toHaveLength(11);
    const steps = r.slice(1).map((p, i) => haversine(r[i].lat, r[i].lon, p.lat, p.lon));
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(2);
    expect(routeDistance(base, base)).toBeLessThan(6); // плотность сравнения ≈ 10 м: нулевой разницы не бывает
  });
});

describe('GPX из нескольких маршрутов', () => {
  it('содержит все маршруты и экранирует имена; приватная зона целиком скрывает короткие', () => {
    const gpx = toMultiGpx([{ name: 'Утро <1>', startMs: 0, track: route(2000) }, { name: 'Короткий', startMs: 0, track: route(150) }], 100);
    expect(gpx.match(/<trk>/g)).toHaveLength(1);
    expect(gpx).toContain('Утро &lt;1&gt;');
    expect(gpx).not.toContain('Короткий');
    expect(toMultiGpx([{ name: 'A', startMs: 0, track: route(600) }, { name: 'B', startMs: 0, track: route(600) }]).match(/<trk>/g)).toHaveLength(2);
  });
});

describe('конфликты: логика', () => {
  const local = { id: 'w', updatedAt: 10, deviceId: 'me', title: 'Моя', exercises: [] };
  const remote = (data: Record<string, unknown>, deviceId = 'other', deleted = false) => ({ data, deviceId, deleted });
  it('правка есть только у нас и отличается — конфликт', () => {
    expect(isConflict({ local, remote: remote({ title: 'Чужая', exercises: [] }), localPending: true, myDeviceId: 'me' })).toBe(true);
  });
  it('нет конфликта: нет локальной несинхронизированной правки, то же содержимое, эхо, нет локальной записи', () => {
    expect(isConflict({ local, remote: remote({ title: 'Чужая' }), localPending: false, myDeviceId: 'me' })).toBe(false);
    expect(isConflict({ local, remote: remote({ title: 'Моя', exercises: [], updatedAt: 99, deviceId: 'other' }), localPending: true, myDeviceId: 'me' })).toBe(false);
    expect(isConflict({ local, remote: remote({ title: 'Чужая' }, 'me'), localPending: true, myDeviceId: 'me' })).toBe(false);
    expect(isConflict({ local: undefined, remote: remote({}), localPending: true, myDeviceId: 'me' })).toBe(false);
  });
  it('чужое удаление поверх нашей правки — конфликт', () => {
    expect(isConflict({ local, remote: remote({}, 'other', true), localPending: true, myDeviceId: 'me' })).toBe(true);
  });
  it('сравнение не зависит от порядка ключей и служебных полей', () => {
    expect(sameContent({ a: 1, b: { x: [1, 2], y: 2 }, updatedAt: 1 }, { b: { y: 2, x: [1, 2] }, a: 1, updatedAt: 2, deviceId: 'z' })).toBe(true);
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('конфликты: запись при синхронизации (fake-indexeddb)', () => {
  it('перезаписанная чужой правкой несинхронизированная правка сохраняется как конфликт', async () => {
    const { db } = await import('../../src/db/db');
    const { applyRemote } = await import('../../src/sync/sync');
    await db.kv.put({ key: 'deviceId', value: 'me-device' });
    const mine = { id: 'wk1', date: '2026-10-20', title: 'Моя правка', status: 'done', exercises: [], createdAt: 1, updatedAt: 1000, deviceId: 'me-device' };
    await db.workouts.put(mine as unknown as Workout);
    await db.changes.add({ table: 'workouts', entityId: 'wk1', op: 'put', deviceId: 'me-device', at: 1000, synced: 0 } as never);
    const theirs = { table: 'workouts' as const, id: 'wk1', updatedAt: 2000, deviceId: 'phone', deleted: false, data: { ...mine, title: 'Чужая правка', updatedAt: 2000, deviceId: 'phone' } };
    await applyRemote([theirs], [], 5);
    expect((await db.workouts.get('wk1'))!.title).toBe('Чужая правка');            // как и раньше: побеждает более новая
    const c = await db.conflicts.toArray();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ table: 'workouts', entityId: 'wk1', resolved: 0, remoteDeviceId: 'phone' });
    expect((c[0].local as { title: string }).title).toBe('Моя правка');
    expect(c[0].label).toContain('Моя правка');
  });
});

import { chatToMarkdown } from '../../src/assistant/transcript';
describe('экспорт диалога', () => {
  it('Markdown с ролями, предложениями и пометкой об остановке', () => {
    const md = chatToMarkdown([
      { id: '1', role: 'user', content: 'Составь тренировку' },
      { id: '2', role: 'assistant', content: 'Вот план.', proposals: [{ id: 'p', date: '2026-10-28', title: 'Грудь и спина', exercises: [] }], stopped: true },
      { id: '3', role: 'assistant', content: '', error: 'Нет связи' }
    ], new Date('2026-10-26T12:00:00'));
    expect(md).toContain('# Диалог с ассистентом, 26 октября 2026');
    expect(md).toContain('## Вы\n\nСоставь тренировку');
    expect(md).toContain('## Ассистент\n\nВот план.');
    expect(md).toContain('> Предложена тренировка: Грудь и спина (2026-10-28)');
    expect(md).toContain('> Ответ остановлен.');
    expect(md).not.toContain('Нет связи');
  });
});
