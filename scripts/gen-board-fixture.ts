// Подписанные сообщения, собранные настоящим клиентским кодом (src/social/world.ts), для проверки board/ на Python.
// Если форматы разойдутся (каноничный JSON, подписи Ed25519 и P-256), тест tests/test_board.py это покажет.
// Запуск: npx vite-node scripts/gen-board-fixture.ts
import 'fake-indexeddb/auto';
import { writeFileSync } from 'node:fs';
import { generateIdentityKey, profileIdFor } from '../src/social/crypto';
import { buildJoin, buildLeave, buildReport, buildWorldSnapshots, type Signer } from '../src/social/world';
import { SEED_EXERCISES } from '../src/domain/seed';
import type { Exercise, Workout } from '../src/domain/types';

const NOW = new Date('2026-10-27T12:00:00Z');
const meta = { createdAt: 0, updatedAt: 0, deviceId: 'd' };
const exercises: Exercise[] = SEED_EXERCISES.map((e) => ({ ...e, ...meta, custom: false }));
const set = (weight: number, reps: number) => ({ id: Math.random().toString(36).slice(2), weight, reps, done: true });
const workout = (date: string, ex: string, sets: [number, number][]): Workout => ({
  id: Math.random().toString(36).slice(2), ...meta, date, title: 'T', status: 'done',
  exercises: [{ id: 'x' + date + ex, exerciseId: ex, sets: sets.map(([w, r]) => set(w, r)) }]
});
const run = (date: string): Workout => ({
  id: 'run' + date, ...meta, date, title: 'Бег', status: 'done',
  exercises: [{ id: 'r' + date, exerciseId: SEED_EXERCISES.find((e) => e.name === 'Бег')!.id, sets: [], cardio: { source: 'manual', distanceM: 5000, durationSec: 1500 } }]
});
const workouts = [
  workout('2026-10-26', 'seed-001', [[100, 5], [100, 5], [90, 8]]),
  workout('2026-10-27', 'seed-011', [[140, 5], [140, 5]]),
  workout('2026-10-05', 'seed-006', [[80, 8], [80, 8]]),
  workout('2026-08-01', 'seed-010', [[160, 3]]),
  run('2026-10-26')
];

async function identity(alg: 'ed25519' | 'p256') {
  const k = await generateIdentityKey(alg);
  const s: Signer = { profileId: await profileIdFor(k.publicKey), publicKey: k.publicKey, alg: k.alg, privateKey: k.privateKey };
  const t = NOW.getTime();
  return {
    profileId: s.profileId, publicKey: s.publicKey, alg: s.alg,
    join: await buildJoin(s, 'Саша Иванов', t),
    join2: await buildJoin(s, 'Саша', t + 1000),
    snapshots: await buildWorldSnapshots(s, 'Саша Иванов', workouts, exercises, NOW),
    snapshots_later: await buildWorldSnapshots(s, 'Саша Иванов', workouts, exercises, new Date(t + 60_000)),
    leave: await buildLeave(s, t + 2000),
    report_signer: s
  };
}

const ed = await identity('ed25519');
const p = await identity('p256');
const report = await buildReport(ed.report_signer, p.profileId, 'cheat', NOW.getTime() + 3000);
const strip = ({ report_signer: _r, ...rest }: Awaited<ReturnType<typeof identity>>) => rest;
writeFileSync(new URL('../tests/fixtures/board_fixture.json', import.meta.url), JSON.stringify({ now: NOW.getTime(), ed: strip(ed), p256: strip(p), report }, null, 1));
console.log('tests/fixtures/board_fixture.json записан;', ed.alg, p.alg);
