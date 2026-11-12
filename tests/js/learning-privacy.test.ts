import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStats, periodFor } from '../../src/social/leaderboard';
import { validateSnapshot } from '../../src/social/snapshot';

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });

describe('отметки о курсах приватны', () => {
  it('снимок для друзей и рейтинга строится из тренировок: попыток в нём нет и быть не может', () => {
    expect(buildStats.length).toBe(3); // (workouts, exercises, period): таблицы learning среди входов нет
    const json = JSON.stringify(buildStats([], [], periodFor('week')));
    expect(json).not.toMatch(/learning|courseId|muscle-growth|passed|attempt/i);
  });

  it('проверка снимка отбрасывает посторонние поля', () => {
    const raw = {
      v: 1, profileId: 'p_' + 'a'.repeat(22), displayName: 'x', publicKey: 'ed25519:' + 'A'.repeat(43), generatedAt: 1, nonce: 'abcdefgh1234', sig: 'S'.repeat(40),
      period: { from: '2026-10-26', to: '2026-11-01', tz: 'UTC' }, totals: { workouts: 1, workSets: 3, volumeKg: 100 }, exercises: [], cardio: { distanceKm: 0, movingSec: 0, sessions: 0 },
      learning: [{ courseId: 'muscle-growth', passed: true }], marks: { 'muscle-growth': true }
    };
    const out = validateSnapshot(raw);
    expect(JSON.stringify(out ?? {})).not.toMatch(/learning|courseId|muscle-growth|marks/);
  });

  it('код друзей и рейтинга на клиенте про попытки не знает', () => {
    const bad = files('src/social').filter((f) => /learning|LearningAttempt|courseId/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
