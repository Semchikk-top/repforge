import { describe, expect, it } from 'vitest';
import { canonicalJson, generateIdentityKey, keyFingerprint, profileIdFor, signText, verifyText } from '../../src/social/crypto';
import { buildStats, exerciseKey, hasWarmupMarks, periodFor } from '../../src/social/leaderboard';
import { buildCardioTable, buildTable, exerciseChoices, type Participant } from '../../src/social/ranking';
import { checkSnapshot, MAX_AGE_MS, randomNonce, signSnapshot, validateSnapshot, type LeaderboardSnapshot, type UnsignedSnapshot } from '../../src/social/snapshot';
import { workoutVolume } from '../../src/domain/analytics';
import type { Exercise, Workout } from '../../src/domain/types';

const ex = (id: string, name: string, muscle: Exercise['muscle'] = 'chest', custom = false, equipment = 'штанга'): Exercise =>
  ({ id, name, muscle, equipment, custom, updatedAt: 1, deviceId: 'd' } as unknown as Exercise);
const EX = [ex('seed-001', 'Жим лёжа'), ex('seed-020', 'Присед', 'legs'), ex('run', 'Бег', 'cardio'), ex('c1', '  Жим  Гантелей ', 'chest', true, 'Гантели')];
const set = (weight: number, reps: number, extra: object = {}) => ({ id: Math.random().toString(), weight, reps, done: true, ...extra });
const wk = (date: string, exercises: Workout['exercises'], status: Workout['status'] = 'done', extra: object = {}): Workout =>
  ({ id: date + Math.random(), date, title: 'T', status, exercises, updatedAt: 1, deviceId: 'd', ...extra } as unknown as Workout);
const we = (exerciseId: string, sets: ReturnType<typeof set>[], cardio?: object) => ({ id: Math.random().toString(), exerciseId, sets, ...(cardio ? { cardio } : {}) }) as unknown as Workout['exercises'][number];

const NOW = new Date('2026-10-28T12:00:00'); // среда
const period = periodFor('week', NOW);

describe('периоды', () => {
  it('неделя: с понедельника по воскресенье; 4 недели: 28 дней; всё время', () => {
    expect(period).toMatchObject({ from: '2026-10-26', to: '2026-11-01' });
    expect(periodFor('4weeks', NOW)).toMatchObject({ from: '2026-10-01', to: '2026-10-28' });
    expect(periodFor('all', NOW)).toMatchObject({ from: '1970-01-01', to: '2026-10-28' });
    expect(period.tz.length).toBeGreaterThan(0);
  });
});

describe('метрики', () => {
  it('тоннаж, подходы, e1RM по упражнению; разминка, недоделанные и чужие периоды не считаются', () => {
    const ws = [
      wk('2026-10-27', [we('seed-001', [set(60, 10, { warmup: true }), set(100, 5), set(100, 5), set(80, 8, { done: false })]), we('seed-020', [set(120, 3)])]),
      wk('2026-10-28', [we('seed-001', [set(105, 3)])]),
      wk('2026-10-20', [we('seed-001', [set(200, 10)])]),       // прошлая неделя
      wk('2026-10-28', [we('seed-001', [set(300, 10)])], 'active'), // не завершена
      wk('2026-10-28', [we('seed-001', [set(300, 10)])], 'done', { deletedAt: 5 })
    ];
    const s = buildStats(ws, EX, period);
    expect(s.totals).toEqual({ workouts: 2, workSets: 4, volumeKg: 100 * 5 * 2 + 120 * 3 + 105 * 3 });
    const bench = s.exercises.find((e) => e.key === 'seed-001')!;
    expect(bench).toMatchObject({ workSets: 3, volumeKg: 1000 + 315 });
    expect(bench.e1rmKg).toBe(Math.round(100 * (1 + 5 / 30) * 10) / 10);
    expect(s.exercises[0].key).toBe('seed-001'); // по объёму
  });

  it('разминка не раздувает объём и в существующей аналитике', () => {
    const w = wk('2026-10-27', [we('seed-001', [set(60, 10, { warmup: true }), set(100, 5)])]);
    expect(workoutVolume(w)).toBe(500);
  });

  it('упражнения без веса: подходы считаются, тоннаж и e1RM нулевые', () => {
    const s = buildStats([wk('2026-10-27', [we('seed-001', [set(0, 12), set(0, 10)])])], EX, period);
    expect(s.totals).toMatchObject({ workSets: 2, volumeKg: 0 });
    expect(s.exercises[0]).toMatchObject({ workSets: 2, volumeKg: 0, e1rmKg: 0 });
  });

  it('кардио отдельно: километры не смешиваются с килограммами', () => {
    const s = buildStats([
      wk('2026-10-27', [we('run', [], { source: 'manual', distanceM: 5200, durationSec: 1800 }), we('seed-020', [set(100, 5)])]),
      wk('2026-10-28', [we('run', [], { source: 'gps', distanceM: 3000, durationSec: 1000 })])
    ], EX, period);
    expect(s.cardio).toEqual({ distanceKm: 8.2, movingSec: 2800, sessions: 2 });
    expect(s.totals.volumeKg).toBe(500);
    expect(s.totals.workouts).toBe(2);
    expect(s.exercises.map((e) => e.key)).toEqual(['seed-020']);
  });

  it('ключ упражнения: у своих — нормализованное имя + группа + оборудование', () => {
    expect(exerciseKey(EX[0])).toBe('seed-001');
    expect(exerciseKey(EX[3])).toBe('c:жим гантелей|chest|гантели');
    expect(exerciseKey(ex('c2', 'жим ГАНТЕЛЕЙ', 'chest', true, ' гантели '))).toBe(exerciseKey(EX[3]));
    expect(exerciseKey(ex('c3', 'Жим гантелей', 'shoulders', true, 'Гантели'))).not.toBe(exerciseKey(EX[3]));
  });

  it('пустой период и отметки разминки', () => {
    expect(buildStats([], EX, period)).toEqual({ totals: { workouts: 0, workSets: 0, volumeKg: 0 }, exercises: [], cardio: { distanceKm: 0, movingSec: 0, sessions: 0 } });
    expect(hasWarmupMarks([wk('2026-10-27', [we('seed-001', [set(100, 5)])])])).toBe(false);
    expect(hasWarmupMarks([wk('2026-10-27', [we('seed-001', [set(40, 5, { warmup: true })])])])).toBe(true);
  });

  it('число упражнений ограничено', () => {
    const many = Array.from({ length: 260 }, (_, i) => ex(`c${i}`, `Своё ${i}`, 'core', true));
    const s = buildStats([wk('2026-10-27', many.map((e) => we(e.id, [set(10, 10)])))], many, period);
    expect(s.exercises.length).toBe(200);
  });
});

describe('ключи и подписи', () => {
  it('подпись проверяется, подмена текста и подписи — нет', async () => {
    const k = await generateIdentityKey();
    expect(k.publicKey).toMatch(/^(ed25519|p256):/);
    const sig = await signText(k, 'привет');
    expect(await verifyText(k.publicKey, 'привет', sig)).toBe(true);
    expect(await verifyText(k.publicKey, 'привет!', sig)).toBe(false);
    // портим символ в середине подписи: «AA» в конце иногда совпадало с настоящим окончанием, и тест мигал
    const mid = Math.floor(sig.length / 2);
    expect(await verifyText(k.publicKey, 'привет', sig.slice(0, mid) + (sig[mid] === 'A' ? 'B' : 'A') + sig.slice(mid + 1))).toBe(false);
    const other = await generateIdentityKey();
    expect(await verifyText(other.publicKey, 'привет', sig)).toBe(false);
    expect(await verifyText('мусор', 'привет', sig)).toBe(false);
    expect(await verifyText(k.publicKey, 'привет', 'x'.repeat(500))).toBe(false);
  });

  it('запасной алгоритм P-256 работает так же', async () => {
    const k = await generateIdentityKey('p256');
    expect(k.alg).toBe('p256');
    expect(await verifyText(k.publicKey, 'a', await signText(k, 'a'))).toBe(true);
  });

  it('profileId выводится из ключа, отпечаток стабилен', async () => {
    const k = await generateIdentityKey();
    expect(await profileIdFor(k.publicKey)).toMatch(/^p_[A-Za-z0-9_-]{22}$/);
    expect(await profileIdFor(k.publicKey)).toBe(await profileIdFor(k.publicKey));
    expect(await keyFingerprint(k.publicKey)).toMatch(/^([0-9A-F]{4}-){3}[0-9A-F]{4}$/);
    expect(await profileIdFor((await generateIdentityKey()).publicKey)).not.toBe(await profileIdFor(k.publicKey));
  });

  it('каноничный JSON не зависит от порядка ключей', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});

async function snap(name = 'Дима', over: Partial<UnsignedSnapshot> = {}, stats = buildStats([wk('2026-10-27', [we('seed-001', [set(100, 5)])])], EX, period)) {
  const key = await generateIdentityKey();
  const u: UnsignedSnapshot = { v: 1, profileId: await profileIdFor(key.publicKey), displayName: name, publicKey: key.publicKey, period, generatedAt: NOW.getTime(), nonce: randomNonce(), ...stats, ...over };
  return { key, s: await signSnapshot(u, key) };
}

describe('снимок: проверка входящего', () => {
  const now = NOW.getTime();

  it('подписанный снимок принимается', async () => {
    const { s } = await snap();
    const r = await checkSnapshot(JSON.parse(JSON.stringify(s)), now);
    expect(r.result).toBe('ok');
    expect(r.snapshot!.totals.volumeKg).toBe(500);
  });

  it('любая подмена чисел ломает подпись', async () => {
    const { s } = await snap();
    const forged = { ...s, totals: { ...s.totals, volumeKg: 99999 } };
    expect((await checkSnapshot(forged, now)).result).toBe('bad-signature');
    expect((await checkSnapshot({ ...s, displayName: 'Другой' }, now)).result).toBe('bad-signature');
  });

  it('чужой ключ при закреплённом ключе друга — отказ', async () => {
    const a = await snap('Аня'), b = await snap('Самозванец');
    expect((await checkSnapshot(b.s, now, a.s.publicKey)).result).toBe('wrong-key');
    expect((await checkSnapshot(a.s, now, a.s.publicKey)).result).toBe('ok');
  });

  it('старые и «из будущего» снимки отклоняются', async () => {
    expect((await checkSnapshot((await snap('A', { generatedAt: now - MAX_AGE_MS - 1000 })).s, now)).result).toBe('too-old');
    expect((await checkSnapshot((await snap('A', { generatedAt: now + 3600_000 })).s, now)).result).toBe('from-future');
    expect((await checkSnapshot((await snap('A', { generatedAt: now - 3600_000 })).s, now)).result).toBe('ok');
  });

  it('неверная форма, диапазоны, версия, размер', async () => {
    const { s } = await snap();
    const bad: unknown[] = [null, 5, 'x', [], {}, { ...s, v: 2 }, { ...s, profileId: 'nope' }, { ...s, publicKey: 'ed25519:x' }, { ...s, period: { from: '2026-10-30', to: '2026-10-01', tz: 'UTC' } },
      { ...s, totals: { ...s.totals, volumeKg: -1 } }, { ...s, totals: { ...s.totals, workSets: Infinity } }, { ...s, exercises: 'x' },
      { ...s, exercises: [{ key: 'k', name: 'n', muscle: 'm', e1rmKg: 'много', volumeKg: 1, workSets: 1 }] }, { ...s, displayName: '' }, { ...s, displayName: 'a\u0000b' }];
    for (const b of bad) expect(validateSnapshot(b), JSON.stringify(b)?.slice(0, 60)).toBeNull();
    const many = await snap('A', {}, { ...buildStats([], EX, period), exercises: Array.from({ length: 201 }, (_, i) => ({ key: 'k' + i, name: 'n', muscle: 'core', e1rmKg: 1, volumeKg: 1, workSets: 1 })) });
    expect((await checkSnapshot(many.s, now)).result).toBe('malformed');
    const huge = await snap('A', { displayName: 'x'.repeat(40) }, { ...buildStats([], EX, period), exercises: Array.from({ length: 200 }, (_, i) => ({ key: 'k'.repeat(120) + i, name: 'n'.repeat(60), muscle: 'core', e1rmKg: 1, volumeKg: 1, workSets: 1 })) });
    expect(['too-big', 'malformed']).toContain((await checkSnapshot(huge.s, now)).result);
  });

  it('лишние поля новой минорной версии не ломают подпись и не сохраняются', async () => {
    const key = await generateIdentityKey();
    const u = { v: 1, profileId: await profileIdFor(key.publicKey), displayName: 'Новый', publicKey: key.publicKey, period, generatedAt: now, nonce: randomNonce(), ...buildStats([], EX, period), badge: 'gold' };
    const raw = { ...u, sig: await signText(key, canonicalJson(u)) };
    const r = await checkSnapshot(raw, now);
    expect(r.result).toBe('ok');
    expect((r.snapshot as unknown as Record<string, unknown>).badge).toBeUndefined();
  });

  it('вредный текст остаётся просто текстом (имя не разбирается как разметка)', async () => {
    const { s } = await snap('<img src=x onerror=alert(1)>');
    const r = await checkSnapshot(s, now);
    expect(r.result).toBe('ok');
    expect(r.snapshot!.displayName).toBe('<img src=x onerror=alert(1)>'); // React выводит как текст
  });
});

describe('таблицы лидеров', () => {
  const now = NOW.getTime();
  const person = async (name: string, sets: [string, number, number][], isMe = false, over: Partial<UnsignedSnapshot> = {}): Promise<Participant> => {
    const stats = buildStats([wk('2026-10-27', sets.length ? [we('seed-001', sets.map(([, w, r]) => set(w, r)))] : [])], EX, period);
    const { s } = await snap(name, over, stats);
    return { profileId: s.profileId, name, isMe, snapshot: s };
  };

  it('сортировка: метрика, затем подходы, затем имя; места подряд', async () => {
    const a = await person('Борис', [['', 100, 5], ['', 100, 5]], true);   // 1000, 2 подхода
    const b = await person('Аня', [['', 100, 10]]);                        // 1000, 1 подход
    const c = await person('Вика', [['', 200, 10]]);                       // 2000
    const d = await person('Ася', [['', 100, 5], ['', 100, 5]]);           // 1000, 2 подхода: ничья с Борисом → по имени
    const rows = buildTable([a, b, c, d], period, 'volume', now);
    expect(rows.map((r) => [r.name, r.rank])).toEqual([['Вика', 1], ['Ася', 2], ['Борис', 3], ['Аня', 4]]);
  });

  it('человек без данных не пропадает, а помечается', async () => {
    const me = await person('Я', [['', 100, 5]], true);
    const idle = await person('Лентяй', []);
    const none: Participant = { profileId: 'p_x', name: 'Новичок', isMe: false, snapshot: null };
    const rows = buildTable([me, idle, none], period, 'volume', now);
    expect(rows.map((r) => [r.name, r.rank, r.note])).toEqual([['Я', 1, null], ['Лентяй', null, 'нет данных за период'], ['Новичок', null, 'снимка пока нет']]);
  });

  it('снимок за другой период не сравнивается; старый — с датой', async () => {
    const me = await person('Я', [['', 100, 5]], true);
    const other = await person('Прошлый', [['', 500, 5]], false, { period: { from: '2026-10-19', to: '2026-10-25', tz: 'UTC' } });
    const old = await person('Давний', [['', 50, 5]], false, { generatedAt: now - 10 * 24 * 3600_000 });
    const rows = buildTable([me, other, old], period, 'volume', now);
    expect(rows.find((r) => r.name === 'Прошлый')).toMatchObject({ rank: null, note: expect.stringContaining('другой период') });
    expect(rows.find((r) => r.name === 'Давний')).toMatchObject({ rank: 2, note: expect.stringMatching(/^снимок от \d\d\.\d\d$/) });
    expect(rows[0].name).toBe('Я');
  });

  it('по упражнению: e1RM, объём, подходы; выбор упражнений по числу участников', async () => {
    const a = await person('А', [['', 100, 5]], true), b = await person('Б', [['', 90, 8]]);
    expect(buildTable([a, b], period, 'e1rm', now, 'seed-001').map((r) => r.name)).toEqual(['А', 'Б']); // 100×5 → 116.7 против 90×8 → 114
    expect(buildTable([a, b], period, 'sets', now, 'seed-001').every((r) => r.rank !== null)).toBe(true);
    expect(buildTable([a, b], period, 'volume', now, 'seed-020').every((r) => r.rank === null && r.note === 'нет данных за период')).toBe(true);
    expect(exerciseChoices([a, b], period)).toEqual([{ key: 'seed-001', name: 'Жим лёжа', people: 2 }]);
  });

  it('кардио — отдельная таблица в километрах', async () => {
    const run = (km: number) => buildStats([wk('2026-10-27', [we('run', [], { source: 'manual', distanceM: km * 1000, durationSec: 100 })])], EX, period);
    const a = (await snap('А', {}, run(10))).s, b = (await snap('Б', {}, run(12))).s, c = (await snap('В', {}, buildStats([], EX, period))).s;
    const rows = buildCardioTable([a, b, c].map((s, i) => ({ profileId: s.profileId, name: s.displayName, isMe: i === 0, snapshot: s as LeaderboardSnapshot })), period, now);
    expect(rows.map((r) => [r.name, r.rank, r.value])).toEqual([['Б', 1, 12], ['А', 2, 10], ['В', null, null]]);
  });
});

import { BUNDLE_TYPE, makeBundleText, parseBundleText } from '../../src/social/bundle';

describe('обмен файлом', () => {
  const now = NOW.getTime();
  async function made(name = 'Аня') {
    const { key, s } = await snap(name);
    const second = await signSnapshot({ ...(({ sig, ...u }) => u)(s), period: periodFor('4weeks', NOW), nonce: randomNonce() }, key);
    const card = { profileId: s.profileId, publicKey: s.publicKey, displayName: name };
    return { card, snaps: [s, second] as LeaderboardSnapshot[], key };
  }

  it('пакет принимается и проверяется, карточка совпадает с ключом', async () => {
    const { card, snaps } = await made();
    const r = await parseBundleText(makeBundleText(card, snaps), now);
    expect(r.ok && r.bundle.snapshots.length).toBe(2);
    expect(r.ok && r.bundle.card).toEqual(card);
  });

  it('подделанный снимок отбрасывается, остальные остаются; все поддельные — ошибка', async () => {
    const { card, snaps } = await made();
    const forged = { ...snaps[1], totals: { ...snaps[1].totals, volumeKg: 1e6 } };
    const r = await parseBundleText(makeBundleText(card, [snaps[0], forged]), now);
    expect(r.ok && [r.bundle.snapshots.length, r.bundle.rejected]).toEqual([1, 1]);
    const r2 = await parseBundleText(makeBundleText(card, [forged]), now);
    expect(r2).toEqual({ ok: false, error: 'no-valid-snapshots' });
  });

  it('чужая карточка, закреплённый ключ, мусор и размер', async () => {
    const a = await made('А'), b = await made('Б');
    expect(await parseBundleText(makeBundleText({ ...a.card, profileId: b.card.profileId }, a.snaps), now)).toEqual({ ok: false, error: 'bad-card' });
    expect(await parseBundleText(makeBundleText(b.card, b.snaps), now, a.card.publicKey)).toEqual({ ok: false, error: 'wrong-key' });
    expect(await parseBundleText('не json', now)).toEqual({ ok: false, error: 'not-a-bundle' });
    expect(await parseBundleText(JSON.stringify({ type: 'other' }), now)).toEqual({ ok: false, error: 'not-a-bundle' });
    expect(await parseBundleText('x'.repeat(300_001), now)).toEqual({ ok: false, error: 'too-big' });
    expect(BUNDLE_TYPE).toBe('workout-pwa-friend-bundle');
  });

  it('снимок чужого человека в пакете другого — отклонён', async () => {
    const a = await made('А'), b = await made('Б');
    const r = await parseBundleText(makeBundleText(a.card, [b.snaps[0]]), now);
    expect(r).toEqual({ ok: false, error: 'no-valid-snapshots' });
  });
});
