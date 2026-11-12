import { useEffect, useMemo, useRef, useState } from 'react';
import { platform } from '../platform';
import type { LatLon, PlannedRoute, Sport } from '../domain/types';
import { SPORT_LABELS } from '../domain/types';
import { useSettings } from '../state/settings';
import { Toggle } from '../ui/Toggle';
import type { IntervalPlan } from '../domain/types';
import { IntervalBuilder } from './IntervalBuilder';
import { formatDuration } from '../lib';
import { geocodeErrorText, searchAddress, type GeoResult } from './geocode';
import { formatKm } from './geo';
import { NavMap, type MapFailReason } from './NavMap';
import { RouteMap } from './RouteMap';
import { targetFromText } from './target';
import { prepareRoutePack } from '../tts/packs';
import { MAX_WAYPOINTS, planRoute, profileFor, routeErrorText } from './valhalla';

export interface OutdoorChoice { plan: PlannedRoute | null; targetPaceSecPerKm: number | null; intervals?: IntervalPlan | null }

const FAIL_TEXT: Record<MapFailReason, string> = {
  webgl: 'Карта недоступна: на этом устройстве нет WebGL.',
  import: 'Карту не удалось загрузить.',
  style: 'Карта не загрузилась (нет сети или сервис недоступен).',
  timeout: 'Карта слишком долго загружается.'
};

/**
 * Подготовка к тренировке на улице. Карта и любые внешние запросы начинаются только после явных нажатий:
 * «Показать карту», «Построить маршрут», «Найти». «Просто запись» не требует ничего из этого.
 */
export function OutdoorSetup({ sport, onStart, onClose }: { sport: Sport; onStart: (c: OutdoorChoice) => void; onClose: () => void }) {
  const { settings, update } = useSettings();
  const bike = sport === 'bike';
  const [mapOn, setMapOn] = useState(false);
  const [mapFail, setMapFail] = useState<MapFailReason | null>(null);
  const [origin, setOrigin] = useState<LatLon | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [points, setPoints] = useState<(LatLon & { label?: string })[]>([]);
  const [plan, setPlan] = useState<PlannedRoute | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [ivOn, setIvOn] = useState(false);
  const [ivPlan, setIvPlan] = useState<IntervalPlan | null>(null);
  const abort = useRef<AbortController | null>(null);

  // текущая позиция: одна точка, чтобы показать «где я» и начать маршрут отсюда (это не сетевой запрос)
  useEffect(() => {
    const unsupported = platform.geo.unsupportedReason();
    if (unsupported) { setGpsNote(unsupported); return; }
    let done = false;
    const h = platform.geo.watch(
      (f) => { if (!done && f.acc <= 100) { done = true; setOrigin({ lat: f.lat, lon: f.lon }); h.stop(); } },
      (k) => { setGpsNote(k === 'denied' ? 'Нет доступа к местоположению: старт можно выбрать на карте.' : 'Пока не нашёл сигнал GPS.'); }
    );
    return () => { done = true; h.stop(); abort.current?.abort(); };
  }, []);

  const wps = useMemo(() => (origin ? [origin, ...points] : points), [origin, points]);
  const targetSec = targetFromText(target, bike);
  const targetBad = target.trim() !== '' && targetSec === null;
  const ivBad = ivOn && ivPlan === null; // интервалы включены, но форма с ошибкой
  const intervals = ivOn ? ivPlan : null;

  // Озвучка Fish для маршрута: манёвры и стартовая фраза готовятся сейчас, на ПК, а не во время записи.
  // Не мешает старту: что не успело или не вышло, прозвучит системным голосом.
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const voiceAbort = useRef<AbortController | null>(null);
  const prepareVoice = async (built: PlannedRoute) => {
    voiceAbort.current?.abort();
    if (settings.ttsEngine !== 'fish' || !settings.ttsVoiceId) { setVoiceNote(null); return; }
    const ctl = new AbortController();
    voiceAbort.current = ctl;
    setVoiceNote('Готовлю озвучку маршрута…');
    const r = await prepareRoutePack(built, settings, { signal: ctl.signal, onProgress: (p) => { if (!ctl.signal.aborted) setVoiceNote(`Готовлю озвучку маршрута: ${p.done} из ${p.total}…`); } });
    if (ctl.signal.aborted) return;
    setVoiceNote(r === 'busy' ? 'Озвучка уже готовится: что не успеет, прозвучит системным голосом.'
      : r === 'skipped' ? null
      : r.fatal ? 'ПК с озвучкой недоступен: маршрут будет озвучен системным голосом.'
      : r.failed ? `Озвучка маршрута готова, кроме ${r.failed} фраз: они прозвучат системным голосом.` : 'Озвучка маршрута готова.');
  };

  const changed = () => { setPlan(null); setError(null); setVoiceNote(null); voiceAbort.current?.abort(); };
  const addPoint = (p: LatLon, label?: string) => {
    if (!origin && points.length === 0) { setOrigin(p); changed(); return; } // нет GPS: первая точка — старт
    if (wps.length >= MAX_WAYPOINTS) { setError(`Не больше ${MAX_WAYPOINTS} точек маршрута`); return; }
    setPoints((cur) => [...cur, { lat: p.lat, lon: p.lon, label }]);
    changed();
  };
  const removePoint = (i: number) => { setPoints((cur) => cur.filter((_, k) => k !== i)); changed(); };

  const build = async () => {
    if (wps.length < 2) { setError('Нужны старт и хотя бы одна точка назначения.'); return; }
    abort.current?.abort();
    abort.current = new AbortController();
    setBusy(true); setError(null);
    try {
      const built = await planRoute(profileFor(sport), wps, { signal: abort.current.signal });
      setPlan(built);
      void prepareVoice(built);
    }
    catch (e) { setError(routeErrorText(e)); }
    finally { setBusy(false); }
  };

  const find = async () => {
    setSearching(true); setSearchErr(null);
    try { setResults((await searchAddress(query)).results); }
    catch (e) { setSearchErr(geocodeErrorText(e)); setResults(null); }
    finally { setSearching(false); }
  };

  return (
    <div className="setup-screen" role="dialog" aria-modal="true" aria-label="Подготовка к тренировке на улице">
      <div className="head-row">
        <h1 style={{ margin: 0 }}>{SPORT_LABELS[sport]} на улице</h1>
        <button className="btn small ghost" onClick={onClose}>Назад</button>
      </div>

      {!mapOn ? (
        <div style={{ margin: '10px 0' }}>
          <button className="btn block" onClick={() => setMapOn(true)}>Показать карту</button>
          <p className="sub">Карту, подписи и тайлы отдаёт OpenFreeMap: при показе туда уходит видимая область карты. Пока не нажато, ничего не загружается.</p>
        </div>
      ) : mapFail ? (
        <div style={{ margin: '10px 0' }}>
          <p className="msg-error">{FAIL_TEXT[mapFail]} Маршрут всё равно можно построить и пройти по линии.</p>
          <RouteMap points={plan ? plan.shape : wps} />
        </div>
      ) : (
        <>
          <NavMap className="tall" route={plan} waypoints={wps} current={origin} center={origin} follow={false} onPick={addPoint} onFail={setMapFail} />
          <p className="attrib-note">Нажми на карту, чтобы добавить точку маршрута. Данные: © участники OpenStreetMap, карта OpenFreeMap.</p>
        </>
      )}
      {gpsNote && <p className="sub">{gpsNote}</p>}

      <div className="field">
        <label htmlFor="addr">Адрес или место (по кнопке «Найти»)</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="addr" className="input" maxLength={120} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && query.trim().length >= 3) void find(); }} placeholder="Например, парк Горького" />
          <button className="btn" disabled={searching || query.trim().length < 3} onClick={() => void find()}>{searching ? '…' : 'Найти'}</button>
        </div>
        {searchErr && <p className="msg-error">{searchErr}</p>}
        {results && results.length === 0 && <p className="sub">Ничего не найдено.</p>}
        {results && results.map((r, i) => (
          <button key={i} className="row" onClick={() => { addPoint(r, r.label); setResults(null); setQuery(''); }}>
            <div className="grow"><div className="meta">{r.label}</div></div>
          </button>
        ))}
        <span className="attrib-note">Поиск адреса: Nominatim, © участники OpenStreetMap. Запрос уходит только при нажатии «Найти».</span>
      </div>

      {wps.length > 0 && (
        <div className="field">
          <label>Точки маршрута</label>
          {origin && <div className="wp-row"><span className="grow">Старт: моя позиция</span></div>}
          {points.map((p, i) => (
            <div key={i} className="wp-row">
              <span className="grow">{i === points.length - 1 ? 'Финиш' : `Точка ${i + 1}`}: {p.label ?? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`}</span>
              <button className="btn small ghost" aria-label={`Убрать точку ${i + 1}`} onClick={() => removePoint(i)}>Убрать</button>
            </div>
          ))}
        </div>
      )}

      <button className="btn block" disabled={busy || wps.length < 2} onClick={() => void build()}>{busy ? 'Строю маршрут…' : plan ? 'Перестроить' : 'Построить маршрут'}</button>
      {error && <p className="msg-error">{error}</p>}
      {plan && voiceNote && <p className="sub" role="status">{voiceNote}</p>}
      {plan && <p className="sub" role="status">Маршрут: {formatKm(plan.distanceM)} км, около {formatDuration(plan.durationSec * 1000)}. Для построения начальная и конечная точки ушли сервису маршрутов.</p>}

      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="target">{bike ? 'Целевая скорость, км/ч (необязательно)' : 'Целевой темп, мин/км (необязательно)'}</label>
        <input id="target" className="input" inputMode={bike ? 'decimal' : 'text'} value={target} onChange={(e) => setTarget(e.target.value)} placeholder={bike ? '25' : '6:00'} />
        {targetBad && <span className="msg-error">{bike ? 'Скорость от 3 до 60 км/ч.' : 'Темп вида 6:00, от 2:30 до 20:00.'}</span>}
        <span className="sub">Нужна только для подсказок «быстрее/медленнее цели». Действует на эту тренировку.</span>
      </div>

      <div className="list">
        <div className="row"><div className="grow">Интервалы</div><Toggle label="Интервальная тренировка" checked={ivOn} onChange={setIvOn} /></div>
        {ivOn && <IntervalBuilder sport={sport} onChange={setIvPlan} />}
        <div className="row"><div className="grow">Голос навигации</div><Toggle label="Голос навигации" checked={settings.voiceNav} onChange={(v) => update({ voiceNav: v })} /></div>
        <div className="row"><div className="grow">Тренировочные подсказки</div><Toggle label="Тренировочные подсказки" checked={settings.voiceCoach} onChange={(v) => update({ voiceCoach: v })} /></div>
      </div>
      {!platform.speech.available && <p className="sub">Озвучка на этом устройстве недоступна: подсказки будут только на экране.</p>}
      {platform.speech.available && !platform.speech.background && <p className="sub">В браузере голос может замолкать при выключенном экране. В приложении для телефона он надёжнее.</p>}

      <div className="conn-actions" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={!plan || targetBad || ivBad} onClick={() => onStart({ plan, targetPaceSecPerKm: targetSec, intervals })}>Начать по маршруту</button>
        <button className="btn" disabled={targetBad || ivBad} onClick={() => onStart({ plan: null, targetPaceSecPerKm: targetSec, intervals })}>Просто запись</button>
      </div>
    </div>
  );
}
