// Таблицы лидеров: я + друзья. Честные пометки вместо молчаливых подстановок.
import type { Period } from './leaderboard';
import type { LeaderboardSnapshot } from './snapshot';

export type TotalMetric = 'volume' | 'sets' | 'workouts';
export type ExerciseMetric = 'e1rm' | 'volume' | 'sets';
export const STALE_AFTER_MS = 7 * 24 * 3600 * 1000;

export interface Participant { profileId: string; name: string; isMe: boolean; snapshot: LeaderboardSnapshot | null }

export interface Row {
  profileId: string;
  name: string;
  isMe: boolean;
  rank: number | null;   // null — в таблицу не входит
  value: number | null;
  sets: number;
  note: string | null;   // «нет данных за период», «снимок от …», «другой период …»
  generatedAt: number | null;
}

const fmtDay = (ms: number) => { const d = new Date(ms); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`; };
const fmtDate = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const samePeriod = (a: Period, b: Period) => a.from === b.from && a.to === b.to;

function pick(s: LeaderboardSnapshot, metric: TotalMetric | ExerciseMetric, key?: string): { value: number; sets: number } | null {
  if (key === undefined) {
    if (s.totals.workSets <= 0) return null;
    const value = metric === 'sets' ? s.totals.workSets : metric === 'workouts' ? s.totals.workouts : s.totals.volumeKg;
    return value > 0 ? { value, sets: s.totals.workSets } : null;
  }
  const e = s.exercises.find((x) => x.key === key);
  if (!e || e.workSets <= 0) return null;
  const value = metric === 'e1rm' ? e.e1rmKg : metric === 'volume' ? e.volumeKg : e.workSets;
  return value > 0 ? { value, sets: e.workSets } : null;
}

/** key не задан — общая нагрузка, иначе таблица по упражнению. */
export function buildTable(people: Participant[], mine: Period, metric: TotalMetric | ExerciseMetric, now: number, key?: string): Row[] {
  const ranked: Row[] = [];
  const rest: Row[] = [];
  for (const p of people) {
    const base = { profileId: p.profileId, name: p.name, isMe: p.isMe, sets: 0, generatedAt: p.snapshot?.generatedAt ?? null };
    const s = p.snapshot;
    if (!s) { rest.push({ ...base, rank: null, value: null, note: 'снимка пока нет' }); continue; }
    if (!samePeriod(s.period, mine)) { rest.push({ ...base, rank: null, value: null, note: `снимок за другой период: ${fmtDate(s.period.from)}–${fmtDate(s.period.to)}` }); continue; }
    const v = pick(s, metric, key);
    if (!v) { rest.push({ ...base, rank: null, value: null, note: 'нет данных за период' }); continue; }
    const stale = !p.isMe && now - s.generatedAt > STALE_AFTER_MS;
    ranked.push({ ...base, rank: 0, value: v.value, sets: v.sets, note: stale ? `снимок от ${fmtDay(s.generatedAt)}` : null });
  }
  ranked.sort((a, b) => b.value! - a.value! || b.sets - a.sets || a.name.localeCompare(b.name, 'ru'));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  rest.sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.name.localeCompare(b.name, 'ru'));
  return [...ranked, ...rest];
}

/** Упражнения, по которым есть данные хотя бы у двух участников (для сравнения), затем остальные. */
export function exerciseChoices(people: Participant[], mine: Period): { key: string; name: string; people: number }[] {
  const m = new Map<string, { key: string; name: string; people: number }>();
  for (const p of people) {
    if (!p.snapshot || !samePeriod(p.snapshot.period, mine)) continue;
    for (const e of p.snapshot.exercises) {
      if (e.workSets <= 0) continue;
      const cur = m.get(e.key) ?? { key: e.key, name: e.name, people: 0 };
      cur.people++;
      m.set(e.key, cur);
    }
  }
  return [...m.values()].sort((a, b) => b.people - a.people || a.name.localeCompare(b.name, 'ru'));
}

/** Кардио отдельной таблицей: километры не смешиваются с килограммами. */
export function buildCardioTable(people: Participant[], mine: Period, now: number): Row[] {
  const ranked: Row[] = [], rest: Row[] = [];
  for (const p of people) {
    const base = { profileId: p.profileId, name: p.name, isMe: p.isMe, sets: 0, generatedAt: p.snapshot?.generatedAt ?? null };
    const s = p.snapshot;
    if (!s) { rest.push({ ...base, rank: null, value: null, note: 'снимка пока нет' }); continue; }
    if (!samePeriod(s.period, mine)) { rest.push({ ...base, rank: null, value: null, note: 'снимок за другой период' }); continue; }
    if (s.cardio.distanceKm <= 0) { rest.push({ ...base, rank: null, value: null, note: 'нет данных за период' }); continue; }
    ranked.push({ ...base, rank: 0, value: s.cardio.distanceKm, sets: s.cardio.sessions, note: !p.isMe && now - s.generatedAt > STALE_AFTER_MS ? `снимок от ${fmtDay(s.generatedAt)}` : null });
  }
  ranked.sort((a, b) => b.value! - a.value! || b.sets - a.sets || a.name.localeCompare(b.name, 'ru'));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return [...ranked, ...rest];
}

export interface Standing {
  rank: number;
  of: number;
  /** Сколько не хватает до места выше (в единицах таблицы); null — вы первый или рядом никого. */
  toNext: number | null;
  nextName: string | null;
  /** Отрыв от следующего за вами; null — вы последний или рядом никого. */
  lead: number | null;
  tied: boolean;
}

/** Ваше положение в готовой таблице: место, сколько до следующего выше и отрыв от следующего ниже. Вне таблицы — null. */
export function standing(rows: Row[]): Standing | null {
  const ranked = rows.filter((r) => r.rank !== null && r.value !== null);
  const i = ranked.findIndex((r) => r.isMe);
  if (i < 0) return null;
  const me = ranked[i];
  const above = ranked.slice(0, i).reverse().find((r) => r.value! > me.value!) ?? null;
  const below = ranked.slice(i + 1).find((r) => r.value! < me.value!) ?? null;
  return {
    rank: me.rank!, of: ranked.length,
    toNext: above ? Math.round((above.value! - me.value!) * 100) / 100 : null, nextName: above?.name ?? null,
    lead: below ? Math.round((me.value! - below.value!) * 100) / 100 : null,
    tied: ranked.some((r, j) => j !== i && r.value === me.value)
  };
}
