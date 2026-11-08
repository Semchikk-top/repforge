// Поиск адреса (Nominatim). Только по нажатию «Найти»: не чаще одного запроса в секунду, результаты кэшируются.
// Точка на карте работает всегда, даже если поиск недоступен.

import type { LatLon } from '../domain/types';
import { getMapConfig } from './mapConfig';

export interface GeoResult extends LatLon { label: string }

export const MIN_GAP_MS = 1000;
export const CACHE_MAX = 30;
export const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
export const QUERY_MIN = 3;
export const QUERY_MAX = 120;

export interface LimiterClock { now(): number; sleep(ms: number): Promise<void> }
const realClock: LimiterClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Ограничитель частоты: каждый вызов ждёт, пока с начала предыдущего пройдёт minGapMs. Вызовы выстраиваются в очередь. */
export function createLimiter(minGapMs: number = MIN_GAP_MS, clock: LimiterClock = realClock): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  let last = -Infinity;
  return () => {
    const run = chain.then(async () => {
      const wait = last + minGapMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
      last = clock.now();
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

export const normalizeQuery = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, ' ');

interface Entry { at: number; results: GeoResult[] }

/** Небольшой кэш запросов: в памяти и (если доступно) в localStorage этого устройства. */
export class GeocodeCache {
  private map = new Map<string, Entry>();
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null = null, private key = 'geocode.cache.v1', private now: () => number = Date.now) {
    try {
      const raw = storage?.getItem(key);
      if (raw) for (const [k, e] of JSON.parse(raw) as [string, Entry][]) if (e && Array.isArray(e.results)) this.map.set(k, e);
    } catch { /* повреждённый кэш не страшен */ }
  }
  get(q: string): GeoResult[] | null {
    const k = normalizeQuery(q), e = this.map.get(k);
    if (!e) return null;
    if (this.now() - e.at > CACHE_TTL_MS) { this.map.delete(k); return null; }
    this.map.delete(k); this.map.set(k, e); // свежие в конце
    return e.results;
  }
  set(q: string, results: GeoResult[]): void {
    const k = normalizeQuery(q);
    this.map.delete(k);
    this.map.set(k, { at: this.now(), results });
    while (this.map.size > CACHE_MAX) this.map.delete(this.map.keys().next().value as string);
    try { this.storage?.setItem(this.key, JSON.stringify([...this.map.entries()])); } catch { /* хранилище недоступно */ }
  }
  get size(): number { return this.map.size; }
}

/** Разбор ответа Nominatim (jsonv2). Некорректные записи пропускаются. */
export function parseNominatim(json: unknown): GeoResult[] {
  if (!Array.isArray(json)) return [];
  const out: GeoResult[] = [];
  for (const r of json as { lat?: string; lon?: string; display_name?: string }[]) {
    const lat = Number(r?.lat), lon = Number(r?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const label = (typeof r.display_name === 'string' ? r.display_name : '').trim().slice(0, 140);
    out.push({ lat, lon, label: label || `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
  }
  return out.slice(0, 5);
}

export type GeocodeErrorKind = 'short' | 'network' | 'http';
export class GeocodeError extends Error { constructor(public kind: GeocodeErrorKind, message: string) { super(message); } }

let sharedLimiter: (() => Promise<void>) | null = null;
let sharedCache: GeocodeCache | null = null;

export interface SearchOptions { baseUrl?: string; fetchImpl?: typeof fetch; limiter?: () => Promise<void>; cache?: GeocodeCache; signal?: AbortSignal }

export async function searchAddress(query: string, opts: SearchOptions = {}): Promise<{ results: GeoResult[]; cached: boolean }> {
  const q = query.trim().slice(0, QUERY_MAX);
  if (q.length < QUERY_MIN) throw new GeocodeError('short', 'Введи хотя бы три символа');
  const cache = opts.cache ?? (sharedCache ??= new GeocodeCache(typeof localStorage !== 'undefined' ? localStorage : null));
  const hit = cache.get(q);
  if (hit) return { results: hit, cached: true }; // из кэша: ни запроса, ни ожидания
  const limiter = opts.limiter ?? (sharedLimiter ??= createLimiter());
  await limiter();
  const base = (opts.baseUrl ?? getMapConfig().geocoderUrl).replace(/\/+$/, '');
  const url = `${base}/search?format=jsonv2&limit=5&accept-language=ru&q=${encodeURIComponent(q)}`;
  let res: Response;
  try { res = await (opts.fetchImpl ?? fetch)(url, { signal: opts.signal, referrerPolicy: 'no-referrer', credentials: 'omit' }); }
  catch { throw new GeocodeError('network', 'Нет связи с поиском адресов'); }
  if (!res.ok) throw new GeocodeError('http', `Поиск отказал (${res.status})`);
  let json: unknown;
  try { json = await res.json(); } catch { throw new GeocodeError('http', 'Непонятный ответ поиска'); }
  const results = parseNominatim(json);
  cache.set(q, results);
  return { results, cached: false };
}

export function geocodeErrorText(e: unknown): string {
  if (e instanceof GeocodeError) {
    if (e.kind === 'short') return e.message;
    if (e.kind === 'network') return 'Поиск адреса недоступен без сети. Выбери точку на карте.';
    return 'Поиск адреса сейчас не отвечает. Выбери точку на карте.';
  }
  return 'Поиск не удался. Выбери точку на карте.';
}
