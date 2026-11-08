// Маршрутизация через Valhalla: запрос и разбор ответа. Разбор — чистая функция (её проверяют тесты на готовых ответах),
// сеть только в planRoute. Единицы внутри приложения: метры и секунды.

import type { LatLon, NavManeuver, PlannedRoute, RouteProfile, Sport } from '../domain/types';
import { decodePolyline6 } from './nav';
import { getMapConfig } from './mapConfig';

export const MAX_WAYPOINTS = 10;
export const ROUTE_TIMEOUT_MS = 12_000;

/** Бег и ходьба — пешеходный профиль, велосипед — велосипедный. */
export const profileFor = (sport: Sport): RouteProfile => (sport === 'bike' ? 'bicycle' : 'pedestrian');

export type RouteErrorKind = 'invalid' | 'network' | 'timeout' | 'http' | 'no-route' | 'bad-response';
export class RouteError extends Error {
  constructor(public kind: RouteErrorKind, message: string) { super(message); this.name = 'RouteError'; }
}

const validLatLon = (p: LatLon | undefined): p is LatLon =>
  !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

/** Тело запроса для /route. Все точки «break»: каждая даёт свой участок и свою остановку. */
export function buildRouteRequest(profile: RouteProfile, waypoints: LatLon[]): Record<string, unknown> {
  if (waypoints.length < 2) throw new RouteError('invalid', 'Нужны хотя бы начало и конец маршрута');
  if (waypoints.length > MAX_WAYPOINTS) throw new RouteError('invalid', `Не больше ${MAX_WAYPOINTS} точек маршрута`);
  if (!waypoints.every(validLatLon)) throw new RouteError('invalid', 'Координаты точки некорректны');
  return {
    locations: waypoints.map((w) => ({ lat: Number(w.lat.toFixed(6)), lon: Number(w.lon.toFixed(6)), type: 'break' })),
    costing: profile,
    directions_options: { units: 'kilometers', language: 'ru-RU' }
  };
}

/** Адрес запроса. GET с json=… не требует предзапроса CORS (в отличие от POST с нестандартными заголовками). */
export function routeUrl(base: string, body: Record<string, unknown>): string {
  return `${base.replace(/\/+$/, '')}/route?json=${encodeURIComponent(JSON.stringify(body))}`;
}

interface RawManeuver {
  type?: number; instruction?: string; verbal_transition_alert_instruction?: string; verbal_pre_transition_instruction?: string;
  street_names?: string[]; length?: number; time?: number; begin_shape_index?: number;
}
interface RawLeg { shape?: string; maneuvers?: RawManeuver[]; summary?: { length?: number; time?: number } }

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Разбирает ответ Valhalla в PlannedRoute. У каждого участка (leg) своя линия и свои индексы манёвров:
 * склеиваем линии (общую точку на стыке берём один раз) и сдвигаем индексы. Бросает RouteError('bad-response'), если ответ непонятен.
 */
export function parseValhallaRoute(json: unknown, profile: RouteProfile, waypoints: LatLon[]): PlannedRoute {
  const bad = (why: string) => new RouteError('bad-response', `Непонятный ответ маршрутизатора: ${why}`);
  const trip = (json as { trip?: { legs?: RawLeg[]; summary?: { length?: number; time?: number }; status?: number } } | null)?.trip;
  if (!trip || !Array.isArray(trip.legs) || trip.legs.length === 0) throw bad('нет участков');

  const shape: LatLon[] = [];
  const maneuvers: NavManeuver[] = [];
  trip.legs.forEach((leg, li) => {
    if (typeof leg.shape !== 'string' || !Array.isArray(leg.maneuvers)) throw bad('участок без линии или манёвров');
    let pts: LatLon[];
    try { pts = decodePolyline6(leg.shape); } catch (e) { throw bad(e instanceof Error ? e.message : 'линия'); }
    if (pts.length < 2) throw bad('линия слишком короткая');
    const offset = shape.length === 0 ? 0 : shape.length - 1;     // первая точка следующего участка уже в линии
    shape.push(...(shape.length === 0 ? pts : pts.slice(1)));
    const lastLeg = li === trip.legs!.length - 1;
    leg.maneuvers.forEach((m, mi) => {
      const type = num(m.type);
      const via = !lastLeg && mi === leg.maneuvers!.length - 1;      // конец не последнего участка: промежуточная точка
      const instruction = via ? 'Промежуточная точка' : str(m.instruction) ?? '';
      maneuvers.push({
        type,
        instruction,
        ...(via ? { alert: 'Промежуточная точка.', verbal: 'Вы дошли до промежуточной точки.' } : {
          ...(str(m.verbal_transition_alert_instruction) ? { alert: str(m.verbal_transition_alert_instruction) } : {}),
          ...(str(m.verbal_pre_transition_instruction) ? { verbal: str(m.verbal_pre_transition_instruction) } : {})
        }),
        ...(m.street_names?.length && str(m.street_names[0]) ? { street: str(m.street_names[0]) } : {}),
        lengthM: Math.round(num(m.length) * 1000),
        timeSec: Math.round(num(m.time)),
        shapeIndex: Math.min(shape.length - 1, offset + Math.max(0, Math.round(num(m.begin_shape_index)))),
        ...(via ? { via: true } : {})
      });
    });
  });

  const legSum = trip.legs.reduce((a, l) => ({ len: a.len + num(l.summary?.length), time: a.time + num(l.summary?.time) }), { len: 0, time: 0 });
  const distanceM = Math.round((num(trip.summary?.length, legSum.len)) * 1000);
  const durationSec = Math.round(num(trip.summary?.time, legSum.time));
  if (!(distanceM > 0)) throw bad('нулевая длина');
  return { profile, waypoints: waypoints.map((w) => ({ lat: w.lat, lon: w.lon })), shape, distanceM, durationSec, maneuvers };
}

/** Понятное сообщение об ошибке для экрана. */
export function routeErrorText(e: unknown): string {
  if (e instanceof RouteError) {
    switch (e.kind) {
      case 'invalid': return e.message;
      case 'network': return 'Нет связи с сервисом маршрутов. Проверь интернет или выбери «Просто запись».';
      case 'timeout': return 'Сервис маршрутов долго не отвечает. Попробуй ещё раз или выбери «Просто запись».';
      case 'no-route': return 'Маршрут между этими точками не найден. Попробуй сдвинуть точки ближе к дорогам или тропам.';
      case 'http': return 'Сервис маршрутов отказал (возможно, слишком много запросов). Подожди минуту и попробуй снова.';
      case 'bad-response': return 'Сервис маршрутов ответил непонятно. Попробуй ещё раз.';
    }
  }
  return 'Не удалось построить маршрут.';
}

export interface PlanOptions { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }

/** Строит маршрут через Valhalla. Нужна сеть (или свой роутер): это единственный сетевой шаг навигации. */
export async function planRoute(profile: RouteProfile, waypoints: LatLon[], opts: PlanOptions = {}): Promise<PlannedRoute> {
  const body = buildRouteRequest(profile, waypoints);
  const url = routeUrl(opts.baseUrl ?? getMapConfig().routerUrl, body);
  const doFetch = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, opts.timeoutMs ?? ROUTE_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  try {
    let res: Response;
    try { res = await doFetch(url, { method: 'GET', signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' }); }
    catch { throw new RouteError(timedOut ? 'timeout' : 'network', timedOut ? 'Таймаут' : 'Нет сети'); }
    if (res.status === 400 || res.status === 404) {
      // Valhalla отвечает 400 с кодом 171/442 и т.п., когда рядом с точкой нет подходящей дороги
      throw new RouteError('no-route', 'Маршрут не найден');
    }
    if (!res.ok) throw new RouteError('http', `Ошибка ${res.status}`);
    let json: unknown;
    try { json = await res.json(); } catch { throw new RouteError('bad-response', 'Ответ не JSON'); }
    return parseValhallaRoute(json, profile, waypoints);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
