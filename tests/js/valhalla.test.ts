import { describe, expect, it } from 'vitest';
import { createLimiter, GeocodeCache, GeocodeError, normalizeQuery, parseNominatim, searchAddress } from '../../src/cardio/geocode';
import { DEFAULT_GEOCODER_URL, DEFAULT_ROUTER_URL, DEFAULT_STYLE_DARK, DEFAULT_STYLE_LIGHT, getMapConfig, normalizeHttpUrl, originOf } from '../../src/cardio/mapConfig';
import { encodePolyline6 } from '../../src/cardio/nav';
import { buildRouteRequest, parseValhallaRoute, planRoute, profileFor, RouteError, routeUrl } from '../../src/cardio/valhalla';

const A = { lat: 55.75, lon: 37.6 }, B = { lat: 55.752, lon: 37.604 }, C = { lat: 55.756, lon: 37.61 };
const man = (type: number, begin: number, text: string, over: Record<string, unknown> = {}) => ({
  type, instruction: text, verbal_transition_alert_instruction: `${text} скоро.`, verbal_pre_transition_instruction: `${text} сейчас.`, street_names: ['Тверская'], length: 0.1, time: 60, begin_shape_index: begin, ...over
});
const leg1 = { shape: encodePolyline6([A, { lat: 55.751, lon: 37.602 }, B]), maneuvers: [man(1, 0, 'Идите на восток'), man(4, 2, 'Вы прибыли')], summary: { length: 0.3, time: 200 } };
const leg2 = { shape: encodePolyline6([B, { lat: 55.754, lon: 37.607 }, C]), maneuvers: [man(1, 0, 'Идите дальше'), man(15, 1, 'Поверните налево'), man(4, 2, 'Вы прибыли')], summary: { length: 0.5, time: 350 } };

describe('разбор ответа Valhalla', () => {
  it('один участок: линия, длина, время, манёвры в метрах и секундах', () => {
    const r = parseValhallaRoute({ trip: { legs: [leg1], summary: { length: 0.3, time: 200 } } }, 'pedestrian', [A, B]);
    expect(r.shape).toHaveLength(3);
    expect(r.distanceM).toBe(300);
    expect(r.durationSec).toBe(200);
    expect(r.maneuvers.map((m) => m.type)).toEqual([1, 4]);
    expect(r.maneuvers[0]).toMatchObject({ lengthM: 100, timeSec: 60, shapeIndex: 0, street: 'Тверская', alert: 'Идите на восток скоро.' });
    expect(r.maneuvers[1].via).toBeUndefined(); // конец единственного участка — настоящий финиш
  });
  it('два участка склеиваются: общая точка один раз, индексы манёвров сдвинуты, промежуточная точка помечена', () => {
    const r = parseValhallaRoute({ trip: { legs: [leg1, leg2], summary: { length: 0.8, time: 550 } } }, 'bicycle', [A, B, C]);
    expect(r.shape).toHaveLength(5);                       // 3 + 3 − 1 общая
    expect(r.shape[2]).toEqual(r.shape[2]);
    const idx = r.maneuvers.map((m) => m.shapeIndex);
    expect(idx).toEqual([0, 2, 2, 3, 4]);                  // второй участок начинается с индекса 2
    const via = r.maneuvers[1];
    expect(via.via).toBe(true);
    expect(via.instruction).toBe('Промежуточная точка');
    expect(r.maneuvers[4].via).toBeUndefined();
    expect(r.profile).toBe('bicycle');
    expect(r.distanceM).toBe(800);
  });
  it('без сводки длина берётся из сумм участков', () => {
    expect(parseValhallaRoute({ trip: { legs: [leg1, leg2] } }, 'pedestrian', [A, B, C]).distanceM).toBe(800);
  });
  it('непонятные ответы — понятная ошибка, а не исключение', () => {
    for (const bad of [null, {}, { trip: {} }, { trip: { legs: [] } }, { trip: { legs: [{ shape: 'ab', maneuvers: [] }] } }, { trip: { legs: [{ maneuvers: [] }] } }]) {
      expect(() => parseValhallaRoute(bad, 'pedestrian', [A, B])).toThrow(RouteError);
    }
  });
});

describe('запрос маршрута', () => {
  it('профиль: бег и ходьба — пешком, велосипед — велосипедный', () => {
    expect(profileFor('run')).toBe('pedestrian'); expect(profileFor('walk')).toBe('pedestrian'); expect(profileFor('bike')).toBe('bicycle');
  });
  it('тело: точки, профиль, русский язык, километры', () => {
    const b = buildRouteRequest('pedestrian', [A, B, C]) as { locations: unknown[]; costing: string; directions_options: Record<string, string> };
    expect(b.locations).toHaveLength(3);
    expect(b.costing).toBe('pedestrian');
    expect(b.directions_options).toEqual({ units: 'kilometers', language: 'ru-RU' });
  });
  it('до 10 точек, не меньше двух, координаты проверяются', () => {
    expect(() => buildRouteRequest('pedestrian', [A])).toThrow(RouteError);
    expect(() => buildRouteRequest('pedestrian', Array(11).fill(A))).toThrow(RouteError);
    expect(buildRouteRequest('pedestrian', Array(10).fill(A))).toBeTruthy();
    expect(() => buildRouteRequest('pedestrian', [A, { lat: 91, lon: 0 }])).toThrow(RouteError);
    expect(() => buildRouteRequest('pedestrian', [A, { lat: NaN, lon: 0 }])).toThrow(RouteError);
  });
  it('GET без предзапроса: json в адресе, базовый адрес без хвостового слэша', () => {
    const u = routeUrl('https://r.example/', { a: 1 });
    expect(u).toBe('https://r.example/route?json=%7B%22a%22%3A1%7D');
  });
  const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('успешный запрос возвращает маршрут; ошибки сети, 400 и 500 различаются', async () => {
    const r = await planRoute('pedestrian', [A, B], { baseUrl: 'https://r.example', fetchImpl: ok({ trip: { legs: [leg1] } }) });
    expect(r.distanceM).toBe(300);
    await expect(planRoute('pedestrian', [A, B], { fetchImpl: (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'network' });
    await expect(planRoute('pedestrian', [A, B], { fetchImpl: ok({ error_code: 171 }, 400) })).rejects.toMatchObject({ kind: 'no-route' });
    await expect(planRoute('pedestrian', [A, B], { fetchImpl: ok({}, 429) })).rejects.toMatchObject({ kind: 'http' });
    await expect(planRoute('pedestrian', [A, B], { fetchImpl: ok({ trip: {} }) })).rejects.toMatchObject({ kind: 'bad-response' });
  });
  it('таймаут даёт понятную ошибку', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('abort'))))) as unknown as typeof fetch;
    await expect(planRoute('pedestrian', [A, B], { fetchImpl: hang, timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('адреса сервисов', () => {
  it('по умолчанию — публичные бесплатные, без ключей', () => {
    const c = getMapConfig();
    expect(c).toEqual({ styleLight: DEFAULT_STYLE_LIGHT, styleDark: DEFAULT_STYLE_DARK, routerUrl: DEFAULT_ROUTER_URL, geocoderUrl: DEFAULT_GEOCODER_URL });
    for (const u of Object.values(c)) expect(u.startsWith('https://')).toBe(true);
  });
  it('проверка адреса: https, без логина, без мусора', () => {
    expect(normalizeHttpUrl('https://v.example/')).toBe('https://v.example');
    expect(normalizeHttpUrl('http://v.example')).toBe('');
    expect(normalizeHttpUrl('http://v.example', true)).toBe('http://v.example');
    expect(normalizeHttpUrl('https://u:p@v.example')).toBe('');
    expect(normalizeHttpUrl('javascript:alert(1)')).toBe('');
    expect(normalizeHttpUrl(42)).toBe('');
    expect(originOf('https://v.example:8443/a/b')).toBe('https://v.example:8443');
  });
});

describe('поиск адреса', () => {
  const nominatim = [{ lat: '55.75', lon: '37.6', display_name: 'Красная площадь, Москва' }, { lat: 'x', lon: '1' }, { lat: '10', lon: '200' }];
  it('разбор: некорректные записи отбрасываются', () => {
    expect(parseNominatim(nominatim)).toEqual([{ lat: 55.75, lon: 37.6, label: 'Красная площадь, Москва' }]);
    expect(parseNominatim('oops')).toEqual([]);
  });
  it('не чаще одного запроса в секунду, запросы по очереди', async () => {
    let now = 0; const sleeps: number[] = [];
    const lim = createLimiter(1000, { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
    await lim(); now += 100; await lim(); await lim();
    expect(sleeps).toEqual([900, 1000]);
  });
  it('кэш: повторный запрос не идёт в сеть и не ждёт', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(JSON.stringify(nominatim)); }) as unknown as typeof fetch;
    const cache = new GeocodeCache(null);
    const limiter = async () => {};
    const a = await searchAddress('  Красная   площадь ', { fetchImpl, cache, limiter, baseUrl: 'https://g.example' });
    const b = await searchAddress('красная площадь', { fetchImpl, cache, limiter, baseUrl: 'https://g.example' });
    expect(calls).toBe(1);
    expect(a.cached).toBe(false); expect(b.cached).toBe(true);
    expect(b.results).toEqual(a.results);
    expect(normalizeQuery('  А   Б ')).toBe('а б');
  });
  it('кэш ограничен по размеру и сроку', () => {
    let t = 0; const store: Record<string, string> = {};
    const cache = new GeocodeCache({ getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, 'k', () => t);
    for (let i = 0; i < 40; i++) cache.set('q' + i, []);
    expect(cache.size).toBe(30);
    expect(cache.get('q0')).toBeNull();
    expect(cache.get('q39')).toEqual([]);
    t += 8 * 24 * 3600 * 1000;
    expect(cache.get('q39')).toBeNull();
    const again = new GeocodeCache({ getItem: (k) => store[k] ?? null, setItem: () => {} }, 'k', () => 0);
    expect(again.size).toBeGreaterThan(0); // кэш пережил «перезапуск»
  });
  it('короткий запрос и сбои сети — понятные ошибки', async () => {
    await expect(searchAddress('ab', { cache: new GeocodeCache(null) })).rejects.toBeInstanceOf(GeocodeError);
    const down = (async () => { throw new Error('x'); }) as unknown as typeof fetch;
    await expect(searchAddress('Москва', { fetchImpl: down, cache: new GeocodeCache(null), limiter: async () => {} })).rejects.toMatchObject({ kind: 'network' });
    const bad = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(searchAddress('Москва', { fetchImpl: bad, cache: new GeocodeCache(null), limiter: async () => {} })).rejects.toMatchObject({ kind: 'http' });
  });
});
