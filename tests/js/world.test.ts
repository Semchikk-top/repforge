import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson, generateIdentityKey, profileIdFor, verifyText } from '../../src/social/crypto';
import { periodFor, WORLD_PERIOD_KINDS } from '../../src/social/leaderboard';
import { buildTable, standing, type Participant } from '../../src/social/ranking';
import { checkSnapshot } from '../../src/social/snapshot';
import { boardQueryString, buildJoin, buildLeave, buildReport, buildWorldSnapshots, checkNick, type Signer } from '../../src/social/world';
import { SEED_EXERCISES } from '../../src/domain/seed';
import type { Exercise, Workout } from '../../src/domain/types';

const meta = { createdAt: 0, updatedAt: 0, deviceId: 'd' };
const ex = (id: string, name: string, muscle: Exercise['muscle'] = 'chest', custom = false): Exercise => ({ id, name, muscle, equipment: 'штанга', custom, ...meta });
const EX = [ex('seed-001', 'Жим лёжа'), ex('seed-011', 'Присед', 'legs'), ex('c1', 'Моя секретная тяга', 'back', true)];
const set = (weight: number, reps: number, extra: object = {}) => ({ id: Math.random().toString(), weight, reps, done: true, ...extra });
const wk = (date: string, we: Workout['exercises']): Workout => ({ id: date + Math.random(), ...meta, date, title: 'T', status: 'done', exercises: we });
const we = (exerciseId: string, sets: ReturnType<typeof set>[]) => ({ id: Math.random().toString(), exerciseId, sets });
const NOW = new Date('2026-10-28T12:00:00');

async function signer(alg: 'ed25519' | 'p256' = 'ed25519'): Promise<Signer> {
  const k = await generateIdentityKey(alg);
  return { profileId: await profileIdFor(k.publicKey), publicKey: k.publicKey, alg: k.alg, privateKey: k.privateKey };
}

describe('мировой рейтинг: подписанные сообщения', () => {
  it('вступление, выход и жалоба подписаны ключом участника и содержат нужные поля', async () => {
    const s = await signer();
    for (const m of [await buildJoin(s, 'Ник', 5), await buildLeave(s, 6), await buildReport(s, 'p_' + 'A'.repeat(22), 'cheat', 7)]) {
      const { sig, ...rest } = m;
      expect(await verifyText(s.publicKey, canonicalJson(rest), sig)).toBe(true);
      expect(await verifyText(s.publicKey, canonicalJson({ ...rest, kind: 'other' }), sig)).toBe(false);
      expect(m).toMatchObject({ v: 1, profileId: s.profileId, publicKey: s.publicKey });
      expect(m.nonce.length).toBeGreaterThanOrEqual(8);
    }
    expect((await buildJoin(s, 'Ник', 5)).kind).toBe('join');
    expect(await buildReport(s, 'p_x', 'name', 1)).toMatchObject({ kind: 'report', target: 'p_x', reason: 'name' });
  });

  it('снимки для мира: неделя, месяц, всё время; вместо имени ник; свои упражнения не уходят', async () => {
    const s = await signer('p256');
    const workouts = [
      wk('2026-10-27', [we('seed-001', [set(100, 5), set(60, 10, { warmup: true })]), we('c1', [set(50, 10)])]),
      wk('2026-10-03', [we('seed-011', [set(120, 5)])])
    ];
    const snaps = await buildWorldSnapshots(s, 'Публичный ник', workouts, EX, NOW);
    expect(snaps.map((x) => x.period.from)).toEqual(WORLD_PERIOD_KINDS.map((k) => periodFor(k, NOW).from));
    expect(snaps.map((x) => x.period.from)).toEqual(['2026-10-26', '2026-10-01', '1970-01-01']);
    expect(snaps[1].period.to).toBe('2026-10-31');
    for (const x of snaps) {
      expect(x.displayName).toBe('Публичный ник');
      expect(JSON.stringify(x)).not.toContain('секретная');
      expect(x.exercises.every((e) => /^seed-\d+$/.test(e.key))).toBe(true);
      expect((await checkSnapshot(x, NOW.getTime())).result).toBe('ok');
    }
    // общие итоги учитывают и свои упражнения, а разминка не считается
    expect(snaps[0].totals).toMatchObject({ workouts: 1, workSets: 2, volumeKg: 1000 });
    expect(snaps[0].exercises.map((e) => e.key)).toEqual(['seed-001']);
    expect(snaps[1].totals.workSets).toBe(3);
  });

  it('снимки из фикстуры, собранные клиентом, проходят клиентскую проверку', async () => {
    const f = JSON.parse(readFileSync(new URL('../fixtures/board_fixture.json', import.meta.url), 'utf8'));
    for (const who of ['ed', 'p256']) for (const sn of f[who].snapshots) expect((await checkSnapshot(sn, f.now)).result).toBe('ok');
  });

  it('каталог упражнений сервиса не отстал от seed.ts', () => {
    const file = JSON.parse(readFileSync(new URL('../../board/seed_exercises.json', import.meta.url), 'utf8'));
    const want = Object.fromEntries(SEED_EXERCISES.filter((e) => e.muscle !== 'cardio').map((e) => [e.id, { name: e.name, muscle: e.muscle }]));
    expect(file).toEqual(want);
  });
});

describe('периоды мира и запросы', () => {
  it('календарный месяц, в том числе февраль и високосный год', () => {
    expect(periodFor('month', new Date('2026-10-28T12:00:00'))).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodFor('month', new Date('2026-02-10T12:00:00'))).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodFor('month', new Date('2028-02-10T12:00:00'))).toMatchObject({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('строка запроса таблицы', () => {
    const q = new URLSearchParams(boardQueryString({ kind: 'week', metric: 'e1rm', exercise: 'seed-001', from: '2026-10-26', me: 'p_x', offset: 50 }));
    expect(Object.fromEntries(q)).toEqual({ kind: 'week', metric: 'e1rm', exercise: 'seed-001', period_from: '2026-10-26', me: 'p_x', limit: '50', offset: '50' });
    expect(new URLSearchParams(boardQueryString({ kind: 'all', metric: 'volume' })).has('period_from')).toBe(false);
  });

  it('ник: длина и ссылки', () => {
    expect(checkNick('a')).not.toBeNull();
    expect(checkNick('x'.repeat(25))).not.toBeNull();
    expect(checkNick('зайди на site.ru')).not.toBeNull();
    expect(checkNick('  Саша  ')).toBeNull();
  });
});

describe('таблица друзей: тренировки и положение', () => {
  const snap = (name: string, workouts: number, sets: number, vol: number): Participant => ({
    profileId: name, name, isMe: name === 'Я',
    snapshot: { v: 1, profileId: name, displayName: name, publicKey: 'k', period: periodFor('week', NOW), generatedAt: NOW.getTime(), nonce: 'n', sig: 's',
      totals: { workouts, workSets: sets, volumeKg: vol }, exercises: [], cardio: { distanceKm: 0, movingSec: 0, sessions: 0 } }
  });
  const people = [snap('Я', 3, 20, 4000), snap('Аня', 5, 30, 6000), snap('Боря', 2, 10, 1000), snap('Вера', 3, 25, 4000)];

  it('метрика «Тренировки»', () => {
    const rows = buildTable(people, periodFor('week', NOW), 'workouts', NOW.getTime());
    expect(rows.map((r) => [r.name, r.value, r.rank])).toEqual([['Аня', 5, 1], ['Вера', 3, 2], ['Я', 3, 3], ['Боря', 2, 4]]);
  });

  it('положение: место, расстояние до следующего и отрыв', () => {
    const rows = buildTable(people, periodFor('week', NOW), 'volume', NOW.getTime());
    expect(standing(rows)).toMatchObject({ rank: 3, of: 4, toNext: 2000, nextName: 'Аня', lead: 3000, tied: true });
  });

  it('лидер без соперников и вне таблицы', () => {
    const solo = buildTable([people[0]], periodFor('week', NOW), 'volume', NOW.getTime());
    expect(standing(solo)).toMatchObject({ rank: 1, of: 1, toNext: null, lead: null });
    const none = buildTable([snap('Я', 0, 0, 0), people[1]], periodFor('week', NOW), 'volume', NOW.getTime());
    expect(standing(none)).toBeNull();
  });
});
