// Мировой рейтинг: клиент сервиса board/. Участие добровольное и отключаемое в любой момент.
// Личность та же, что у друзей: профиль с ключом подписи. Паролей и аккаунтов нет, каждый запрос подписан.
// Что уходит на сервис: ник (не имя для друзей), открытый ключ и агрегаты за неделю, месяц и всё время
// (тоннаж, подходы, тренировки, километры; 1ПМ, объём и подходы по стартовым упражнениям).
// Тренировки, даты подходов, заметки, замеры и маршруты не уходят никогда.
import { db } from '../db/db';
import type { Exercise, Workout } from '../domain/types';
import { canonicalJson, signText, type Alg } from './crypto';
import { buildStats, periodFor, WORLD_PERIOD_KINDS, type PeriodKind } from './leaderboard';
import { randomNonce, type LeaderboardSnapshot } from './snapshot';
import { getProfile } from './store';

function normalizeUrl(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+$/i.test(s) ? s : '';
}

/** Адрес сервиса задаётся при сборке: VITE_BOARD_URL=https://board.example. Без него раздел честно говорит, что не подключён. */
export const BOARD_URL: string = normalizeUrl(import.meta.env?.VITE_BOARD_URL);
export const boardConfigured = (): boolean => BOARD_URL !== '';

export type WorldKind = 'week' | 'month' | 'all';
export const WORLD_KINDS: WorldKind[] = ['week', 'month', 'all'];
export type WorldMetric = 'volume' | 'sets' | 'workouts' | 'cardio' | 'e1rm' | 'exvolume' | 'exsets';
export type ReportReason = 'name' | 'cheat' | 'other';
export const REPORT_LABELS: Record<ReportReason, string> = { name: 'Неприемлемый ник', cheat: 'Нереальные цифры', other: 'Другое' };

const CATALOG_KEY = /^seed-\d+$/;

export const NICK_MIN = 2;
export const NICK_MAX = 24;
export const MIN_SUBMIT_GAP_MS = 10 * 60_000;

export interface Signer { profileId: string; publicKey: string; alg: Alg; privateKey: CryptoKey }

// ---------- подписанные сообщения (чистые функции: проверяются тестами и сверяются с board/) ----------
async function signed<T extends Record<string, unknown>>(s: Signer, kind: string, fields: T, now: number): Promise<T & { v: 1; kind: string; profileId: string; publicKey: string; generatedAt: number; nonce: string; sig: string }> {
  const body = { v: 1 as const, kind, profileId: s.profileId, publicKey: s.publicKey, generatedAt: now, nonce: randomNonce(), ...fields };
  return { ...body, sig: await signText(s, canonicalJson(body)) };
}

export const buildJoin = (s: Signer, nick: string, now = Date.now()) => signed(s, 'join', { nick }, now);
export const buildLeave = (s: Signer, now = Date.now()) => signed(s, 'leave', {}, now);
export const buildReport = (s: Signer, target: string, reason: ReportReason, now = Date.now()) => signed(s, 'report', { target, reason }, now);

/** Снимки для мирового рейтинга. Вместо имени для друзей в них ник, настоящее имя наружу не идёт. */
export async function buildWorldSnapshots(s: Signer, nick: string, workouts: Workout[], exercises: Exercise[], now = new Date()): Promise<LeaderboardSnapshot[]> {
  const out: LeaderboardSnapshot[] = [];
  for (const kind of WORLD_PERIOD_KINDS) {
    const period = periodFor(kind, now);
    const stats = buildStats(workouts, exercises, period);
    // свои упражнения (их названия пишет сам человек) наружу не уходят: только каталог приложения; в общих итогах они учтены
    stats.exercises = stats.exercises.filter((e) => CATALOG_KEY.test(e.key));
    const body = {
      v: 1 as const, profileId: s.profileId, displayName: nick, publicKey: s.publicKey, period,
      generatedAt: now.getTime(), nonce: randomNonce(), ...stats
    };
    out.push({ ...body, sig: await signText(s, canonicalJson(body)) });
  }
  return out;
}

// ---------- сеть ----------
export class BoardError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const MESSAGES: Record<string, string> = {
  'bad-nick': 'Ник не подошёл: 2–24 символа, буквы, цифры, пробел и _ - . без ссылок',
  'rate-limit': 'Слишком часто. Подождите немного и повторите',
  banned: 'Участие закрыто модератором',
  'not-joined': 'Вы ещё не в мировом рейтинге',
  'bad-time': 'Часы на устройстве сильно расходятся с сервером: включите автоматическое время',
  implausible: 'Сервис не принял цифры: они выглядят невозможными',
  inconsistent: 'Сервис не принял цифры: итоги не сходятся',
  replay: 'Запрос уже был отправлен',
  stale: 'Новее уже есть',
  full: 'Сервис переполнен, попробуйте позже',
  'too-big': 'Слишком большой запрос',
  'bad-key': 'Ключ профиля не подошёл. Создайте профиль заново',
  'bad-signature': 'Подпись не принята',
  'not-found': 'Участник не найден',
  'period-not-current': 'Период не совпал с датой на сервере: проверьте часы и дату на устройстве'
};

export const boardMessage = (code: string): string => MESSAGES[code] ?? 'Сервис рейтинга ответил ошибкой';

async function call<T>(path: string, init?: RequestInit, timeoutMs = 12_000): Promise<T> {
  if (!boardConfigured()) throw new BoardError('not-configured', 'Мировой рейтинг не подключён в этой сборке');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(BOARD_URL + path, { ...init, signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new BoardError('network', navigator.onLine === false ? 'Нет сети' : 'Сервис рейтинга недоступен');
  } finally { clearTimeout(timer); }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) {
    const code = typeof (data as { error?: unknown })?.error === 'string' ? (data as { error: string }).error : `http-${res.status}`;
    throw new BoardError(code, boardMessage(code));
  }
  return data as T;
}

const postJson = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export interface BoardEntry { rank: number; pid: string; nick: string; tag: string; value: number; sec: number; at: number }
export interface BoardPage {
  period: { kind: WorldKind; from: string; to: string };
  metric: WorldMetric;
  exercise: string | null;
  total: number;
  entries: BoardEntry[];
  me: { rank: number; pid: string; value: number; sec: number; at: number } | null;
  now: number;
}

export interface BoardQuery { kind: WorldKind; metric: WorldMetric; exercise?: string; from?: string; limit?: number; offset?: number; me?: string }

export function boardQueryString(q: BoardQuery): string {
  const p = new URLSearchParams({ kind: q.kind, metric: q.metric, limit: String(q.limit ?? 50), offset: String(q.offset ?? 0) });
  if (q.exercise) p.set('exercise', q.exercise);
  if (q.from) p.set('period_from', q.from);
  if (q.me) p.set('me', q.me);
  return p.toString();
}

export const fetchBoard = (q: BoardQuery) => call<BoardPage>('/v1/board?' + boardQueryString(q));

// ---------- состояние участия (только на этом устройстве) ----------
const KV_KEY = 'world-v1';
export interface WorldState { joined: boolean; nick: string; joinedAt?: number; lastSubmitAt?: number; lastError?: string }
const EMPTY: WorldState = { joined: false, nick: '' };

export async function getWorldState(): Promise<WorldState> {
  const row = await db.kv.get(KV_KEY);
  const v = row?.value as Partial<WorldState> | undefined;
  return v && typeof v === 'object' ? { ...EMPTY, ...v } : { ...EMPTY };
}
const setWorldState = async (patch: Partial<WorldState>): Promise<WorldState> => {
  const next = { ...(await getWorldState()), ...patch };
  await db.kv.put({ key: KV_KEY, value: next });
  return next;
};

async function signer(): Promise<Signer> {
  const me = await getProfile();
  if (!me) throw new BoardError('no-profile', 'Сначала создайте профиль: Профиль → Друзья');
  if (!me.privateKey) throw new BoardError('locked', 'Профиль заблокирован на этом устройстве: введите пароль профиля: Профиль → Друзья');
  return { profileId: me.profileId, publicKey: me.publicKey, alg: me.alg, privateKey: me.privateKey };
}

export function checkNick(raw: string): string | null {
  const n = raw.replace(/\s+/g, ' ').trim();
  if (n.length < NICK_MIN || n.length > NICK_MAX) return `Ник: от ${NICK_MIN} до ${NICK_MAX} символов`;
  if (/https?:|www\.|@|\.(com|ru|net|org)\b/i.test(n)) return 'В нике не должно быть ссылок';
  return null;
}

export async function joinWorld(nick: string): Promise<WorldState> {
  const bad = checkNick(nick);
  if (bad) throw new BoardError('bad-nick', bad);
  const s = await signer();
  const clean = nick.replace(/\s+/g, ' ').trim();
  const res = await postJson<{ ok: boolean; nick: string }>('/v1/join', await buildJoin(s, clean));
  await setWorldState({ joined: true, nick: res.nick, joinedAt: Date.now(), lastError: undefined });
  await submitWorld(true).catch(() => { /* итоги уйдут при следующей попытке */ });
  return getWorldState();
}

/** Выход: сервис удаляет ник и все итоги. Локально участие снимается, только если сервис подтвердил удаление. */
export async function leaveWorld(): Promise<void> {
  const s = await signer();
  await postJson('/v1/leave', await buildLeave(s));
  await setWorldState({ joined: false, lastSubmitAt: undefined, lastError: undefined });
}

let inflight: Promise<boolean> | null = null;

/** Отправляет свежие итоги. Без force не чаще раза в 10 минут. Возвращает true, если что-то принято. */
export function submitWorld(force = false): Promise<boolean> {
  if (inflight) return inflight;
  inflight = (async () => {
    const st = await getWorldState();
    if (!st.joined || !boardConfigured()) return false;
    if (!force && st.lastSubmitAt && Date.now() - st.lastSubmitAt < MIN_SUBMIT_GAP_MS) return false;
    try {
      const s = await signer();
      const [workouts, exercises] = await Promise.all([db.workouts.toArray(), db.exercises.toArray()]);
      const snaps = await buildWorldSnapshots(s, st.nick, workouts, exercises);
      const res = await postJson<{ accepted: number; results: { ok: boolean; reason?: string }[] }>('/v1/submit', { snapshots: snaps });
      const bad = res.results.find((r) => !r.ok && r.reason !== 'stale');
      await setWorldState({ lastSubmitAt: Date.now(), lastError: bad ? boardMessage(bad.reason ?? '') : undefined });
      return res.accepted > 0;
    } catch (e) {
      const code = e instanceof BoardError ? e.code : '';
      // сервис забыл участника (удалён модератором или базу сбросили): снимаем отметку, пусть вступит заново
      if (code === 'not-joined') await setWorldState({ joined: false, lastError: 'Сервис не нашёл ваш ник: вступите заново' });
      else await setWorldState({ lastError: e instanceof Error ? e.message : 'Не удалось отправить итоги' });
      throw e;
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

export async function reportPlayer(target: string, reason: ReportReason): Promise<void> {
  const s = await signer();
  await postJson('/v1/report', await buildReport(s, target, reason));
}

/** Фоновая отправка: при запуске, раз в 15 минут и при возврате в приложение. Тихая: ошибки видны в самом рейтинге. */
let started = false;
export function startWorldSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const tick = () => { if (document.visibilityState === 'visible') void submitWorld().catch(() => {}); };
  setTimeout(tick, 4000);
  setInterval(tick, 15 * 60_000);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('online', tick);
}

export type { PeriodKind };
