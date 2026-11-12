import { describe, expect, it, vi, afterEach } from 'vitest';
import { hasDigits, numberWords, spellNumbers } from '../../src/tts/ruNumbers';
import { Manifest, normalizeText, paramsHashOf, textKey, type KV } from '../../src/tts/cache';
import { createSpeechEngine } from '../../src/tts/engine';
import { createHtmlAudioPlayer, type AudioLike } from '../../src/platform/audio';
import { createWebAudioStore } from '../../src/platform/web';
import { routeTexts, staticTexts } from '../../src/tts/classify';
import { BATCH, preparePhrases, prepareRoutePack, spokenText, type PackDeps } from '../../src/tts/packs';
import type { PackEvent, TtsConfig } from '../../src/tts/api';
import type { AudioPlayerApi, AudioStoreApi } from '../../src/platform/types';
import type { PlannedRoute, NavManeuver } from '../../src/domain/types';
import { arrivedText, finishText, halfText, offRouteText, startText, voiceTextForTest } from './ttsHelpers';
import { coachStep, initialCoachState, maneuverText, zoneText } from '../../src/cardio/voice';
import { ANNOUNCE_THRESHOLDS } from '../../src/cardio/nav';

afterEach(() => { vi.unstubAllGlobals(); });

// ---------- числа словами ----------
describe('числа словами для Fish', () => {
  it('целые с родом по единице измерения', () => {
    expect(spellNumbers('Через 120 метров, поверните налево.')).toBe('Через сто двадцать метров, поверните налево.');
    expect(spellNumbers('1 километр')).toBe('один километр');
    expect(spellNumbers('21 минута 2 секунды')).toBe('двадцать одна минута две секунды');
    expect(spellNumbers('3 километра')).toBe('три километра');
    expect(spellNumbers('1 минута')).toBe('одна минута');
  });
  it('десятичные дроби километров', () => {
    expect(spellNumbers('Маршрут 5,2 километра. Вперёд.')).toBe('Маршрут пять целых две десятых километра. Вперёд.');
    expect(spellNumbers('1,5 километра')).toBe('одна целая пять десятых километра');
    expect(spellNumbers('0,3 километра')).toBe('ноль целых три десятых километра');
    expect(spellNumbers('2,05')).toBe('две целых пять сотых');
    expect(spellNumbers('21,1 километра')).toBe('двадцать одна целая одна десятая километра');
  });
  it('числа без единицы — мужской род, зона пульса', () => {
    expect(spellNumbers('Пульсовая зона 3, умеренная.')).toBe('Пульсовая зона три, умеренная.');
  });
  it('тысячи и границы', () => {
    expect(numberWords(1000)).toBe('одна тысяча');
    expect(numberWords(2005, 'm')).toBe('две тысячи пять');
    expect(numberWords(21_000)).toBe('двадцать одна тысяча');
    expect(numberWords(11_000)).toBe('одиннадцать тысяч');
    expect(numberWords(1_000_000)).toBeNull();
    expect(spellNumbers('1000000 метров')).toBe('1000000 метров'); // вне диапазона остаётся как есть
    expect(numberWords(0)).toBe('ноль');
    expect(numberWords(14, 'f')).toBe('четырнадцать');
  });
  it('порядковые и коды не трогает', () => {
    expect(spellNumbers('Поверните на 5-ю линию')).toBe('Поверните на 5-ю линию');
    expect(spellNumbers('маршрут A1')).toBe('маршрут A1');
    expect(hasDigits(spellNumbers('улица 8-го Марта'))).toBe(true);
    expect(hasDigits(spellNumbers('Через 40 метров'))).toBe(false);
  });
  it('в текст для Fish уходят слова, а ключ считается по исходному тексту', () => {
    expect(spokenText('  Через   40 метров,\nповерните налево. ')).toBe('Через сорок метров, поверните налево.');
    expect(textKey('Через 40 метров')).toBe(textKey('  Через\n40   метров '));
  });
});

// ---------- манифест ----------
const memKV = (): KV & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
};
const entry = (n: string) => ({ name: n, hash: n, ext: 'mp3', bytes: 10 });

describe('манифест озвучки', () => {
  it('ищет по голосу, параметрам и нормализованному тексту', () => {
    const m = new Manifest(memKV());
    m.setParamsHash('p1');
    m.set('v1', 'Запись началась. Вперёд.', entry('a.mp3'));
    expect(m.lookup('v1', ' Запись  началась.\nВперёд. ')?.name).toBe('a.mp3');
    expect(m.lookup('v2', 'Запись началась. Вперёд.')).toBeNull();
    expect(m.lookup('', 'Запись началась. Вперёд.')).toBeNull();
    m.setParamsHash('p2');
    expect(m.lookup('v1', 'Запись началась. Вперёд.')).toBeNull(); // смена параметров: пак устарел
  });
  it('без параметров синтеза пак пуст', () => {
    const m = new Manifest(memKV());
    expect(m.lookup('v1', 'текст')).toBeNull();
  });
  it('переживает перезапуск и битые данные', () => {
    const kv = memKV();
    const a = new Manifest(kv);
    a.setParamsHash('p'); a.set('v', 'текст', entry('x.mp3'));
    expect(new Manifest(kv).lookup('v', 'текст')?.name).toBe('x.mp3');
    kv.map.set('repforge:tts-manifest', '{не json');
    expect(new Manifest(kv).lookup('v', 'текст')).toBeNull();
    expect(new Manifest(null).lookup('v', 'текст')).toBeNull();
  });
  it('invalidateExcept оставляет только текущие голос и параметры и возвращает освободившиеся файлы', () => {
    const m = new Manifest(memKV());
    m.setParamsHash('p1');
    m.set('v1', 'раз', entry('1.mp3')); m.set('v2', 'два', entry('2.mp3'));
    m.setParamsHash('p2');
    m.set('v1', 'раз', entry('3.mp3'));
    expect(m.invalidateExcept('v1').sort()).toEqual(['1.mp3', '2.mp3']);
    expect(m.lookup('v1', 'раз')?.name).toBe('3.mp3');
    expect([...m.referenced()]).toEqual(['3.mp3']);
  });
  it('общий файл не удаляется, пока на него есть ссылка', () => {
    const m = new Manifest(memKV());
    m.setParamsHash('p');
    m.set('v1', 'раз', entry('same.mp3')); m.set('v2', 'раз', entry('same.mp3'));
    expect(m.removeVoice('v1')).toEqual([]);
    expect(m.removeVoice('v2')).toEqual(['same.mp3']);
  });
  it('хэш параметров зависит от формата и значений', () => {
    const p = { temperature: 0.7, topP: 0.7, repetitionPenalty: 1.2, chunkLength: 200, seed: null };
    expect(paramsHashOf(p, 'mp3')).toBe(paramsHashOf({ ...p }, 'mp3'));
    expect(paramsHashOf(p, 'mp3')).not.toBe(paramsHashOf(p, 'wav'));
    expect(paramsHashOf(p, 'mp3')).not.toBe(paramsHashOf({ ...p, temperature: 0.5 }, 'mp3'));
    expect(normalizeText(' а \n б ')).toBe('а б');
  });
});

// ---------- гибридный движок ----------
function rig(over: { available?: boolean; fileExists?: boolean; playResult?: 'ended' | 'failed' | 'throw'; engine?: 'system' | 'fish'; voice?: string } = {}) {
  const spoken: string[] = [];
  const played: string[] = [];
  const released = vi.fn();
  const manifest = new Manifest(memKV());
  manifest.setParamsHash('p'); manifest.set('v1', 'Темп в норме.', entry('n.mp3'));
  let resolvePlay: ((r: 'ended' | 'failed') => void) | null = null;
  const store: AudioStoreApi = {
    available: over.available ?? true,
    put: async () => {}, has: async () => true, remove: async () => {}, list: async () => [],
    open: async (name) => (over.fileExists === false ? null : { url: 'file://' + name, release: released })
  };
  const player: AudioPlayerApi = {
    play: (url) => {
      played.push(url);
      if (over.playResult === 'throw') return Promise.reject(new Error('x'));
      if (over.playResult) return Promise.resolve(over.playResult);
      return new Promise((r) => { resolvePlay = r; });
    },
    stop: async () => { resolvePlay?.('ended'); }
  };
  const system = { speak: async (t: string) => { spoken.push(t); }, stop: vi.fn(async () => {}) };
  const engine = createSpeechEngine({ system, store, player, manifest, settings: () => ({ ttsEngine: over.engine ?? 'fish', ttsVoiceId: over.voice ?? 'v1' }) });
  return { engine, spoken, played, released, system, finish: (r: 'ended' | 'failed') => resolvePlay?.(r) };
}

describe('гибридный движок озвучки', () => {
  it('готовая фраза играет из локального файла, системный голос молчит', async () => {
    const r = rig({ playResult: 'ended' });
    await r.engine.speak('Темп в норме.');
    expect(r.played).toEqual(['file://n.mp3']); expect(r.spoken).toEqual([]); expect(r.released).toHaveBeenCalledOnce();
  });
  it('нет в паке — сразу системный голос', async () => {
    const r = rig({ playResult: 'ended' });
    await r.engine.speak('Километр. Темп 5 минут.');
    expect(r.played).toEqual([]); expect(r.spoken).toEqual(['Километр. Темп 5 минут.']);
  });
  it.each([
    ['файл пропал', { fileExists: false }],
    ['звук не пошёл', { playResult: 'failed' as const }],
    ['плеер упал', { playResult: 'throw' as const }],
    ['хранилища нет', { available: false }],
    ['движок системный', { engine: 'system' as const }],
    ['голос не выбран', { voice: '' }]
  ])('запасной системный голос: %s', async (_n, over) => {
    const r = rig({ playResult: 'ended', ...over });
    await r.engine.speak('Темп в норме.');
    expect(r.spoken).toEqual(['Темп в норме.']);
  });
  it('оборванная stop() фраза не повторяется системным голосом', async () => {
    const r = rig();
    const p = r.engine.speak('Темп в норме.');
    await vi.waitFor(() => expect(r.played.length).toBe(1));
    await r.engine.stop();
    await p;
    expect(r.spoken).toEqual([]); expect(r.system.stop).toHaveBeenCalled(); expect(r.released).toHaveBeenCalled();
  });
  it('stop() до начала воспроизведения отменяет фразу совсем', async () => {
    const r = rig({ playResult: 'ended' });
    const p = r.engine.speak('Темп в норме.');
    await r.engine.stop();
    await p;
    expect(r.played.length + r.spoken.length).toBeLessThanOrEqual(1); // либо успела сыграть до stop, либо отменена; системной дубли нет
    expect(r.spoken).toEqual([]);
  });
  it('в горячем пути нет сетевых вызовов', async () => {
    const f = vi.fn(() => { throw new Error('сеть в горячем пути'); });
    vi.stubGlobal('fetch', f);
    for (const over of [{ playResult: 'ended' as const }, { fileExists: false }, { playResult: 'failed' as const }]) {
      const r = rig(over);
      await r.engine.speak('Темп в норме.'); await r.engine.speak('Любая другая фраза.');
    }
    expect(f).not.toHaveBeenCalled();
  });
});

// ---------- плеер ----------
class FakeAudio implements AudioLike {
  src = ''; onended: (() => void) | null = null; onerror: (() => void) | null = null; onplaying: (() => void) | null = null;
  paused = false; behavior: 'ok' | 'reject' | 'error-late' = 'ok';
  async play() {
    if (this.behavior === 'reject') throw new Error('NotAllowedError');
    queueMicrotask(() => this.onplaying?.());
  }
  pause() { this.paused = true; }
}
describe('HTML-плеер', () => {
  it('доиграл → ended', async () => {
    const a = new FakeAudio(); const pl = createHtmlAudioPlayer(() => a);
    const p = pl.play('x'); await Promise.resolve(); a.onended?.();
    expect(await p).toBe('ended'); expect(a.src).toBe('x');
  });
  it('отказ запуска и ошибка до начала → failed', async () => {
    const a = new FakeAudio(); a.behavior = 'reject';
    expect(await createHtmlAudioPlayer(() => a).play('x')).toBe('failed');
    const b = new FakeAudio(); b.play = async () => { queueMicrotask(() => b.onerror?.()); };
    expect(await createHtmlAudioPlayer(() => b).play('x')).toBe('failed');
  });
  it('ошибка после начала — это уже конец, а не сбой', async () => {
    const a = new FakeAudio(); const pl = createHtmlAudioPlayer(() => a);
    const p = pl.play('x'); await new Promise((r) => setTimeout(r, 0)); a.onerror?.();
    expect(await p).toBe('ended');
  });
  it('stop() обрывает и не считается сбоем', async () => {
    const a = new FakeAudio(); const pl = createHtmlAudioPlayer(() => a);
    const p = pl.play('x'); await new Promise((r) => setTimeout(r, 0)); await pl.stop();
    expect(await p).toBe('ended'); expect(a.paused).toBe(true);
  });
  it('новая фраза вытесняет прежнюю', async () => {
    const list: FakeAudio[] = []; const pl = createHtmlAudioPlayer(() => { const a = new FakeAudio(); list.push(a); return a; });
    const p1 = pl.play('1'); await new Promise((r) => setTimeout(r, 0));
    const p2 = pl.play('2'); await new Promise((r) => setTimeout(r, 0));
    expect(await p1).toBe('ended'); expect(list[0].paused).toBe(true);
    list[1].onended?.(); expect(await p2).toBe('ended');
  });
  it('нет конструктора Audio → failed', async () => {
    expect(await createHtmlAudioPlayer(() => { throw new Error('no audio'); }).play('x')).toBe('failed');
  });
});

// ---------- хранилище браузера ----------
describe('хранилище озвучки в браузере (Cache Storage)', () => {
  it('put/has/open/list/remove', async () => {
    const stores = new Map<string, Map<string, Response>>();
    vi.stubGlobal('caches', {
      open: async (n: string) => {
        const m = stores.get(n) ?? new Map<string, Response>(); stores.set(n, m);
        return {
          put: async (req: Request, res: Response) => { m.set(req.url, res); },
          match: async (req: Request) => m.get(req.url)?.clone(),
          delete: async (req: Request) => m.delete(req.url),
          keys: async () => [...m.keys()].map((u) => new Request(u))
        };
      }
    });
    const created: string[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { created.push('blob:' + b.size); return 'blob:' + b.size; }, revokeObjectURL: vi.fn() }));
    const s = createWebAudioStore();
    expect(s.available).toBe(true);
    await s.put('abc.mp3', new Blob([new Uint8Array(100)], { type: 'audio/mpeg' }));
    expect(await s.has('abc.mp3')).toBe(true); expect(await s.has('zzz.mp3')).toBe(false);
    expect((await s.open('abc.mp3'))?.url).toBe('blob:100'); expect(await s.open('zzz.mp3')).toBeNull();
    expect(await s.list()).toEqual([{ name: 'abc.mp3', bytes: 100 }]);
    await s.remove('abc.mp3');
    expect(await s.has('abc.mp3')).toBe(false);
  });
  it('без Cache Storage недоступно, но не падает', async () => {
    vi.stubGlobal('caches', undefined);
    const s = createWebAudioStore();
    expect(s.available).toBe(false); expect(await s.has('a')).toBe(false); expect(await s.open('a')).toBeNull(); expect(await s.list()).toEqual([]);
  });
});

// ---------- классификация ----------
const man = (over: Partial<NavManeuver> = {}): NavManeuver => ({ type: 15, instruction: 'Поверните налево на улицу Ленина', alert: 'Поверните налево.', verbal: 'Поверните налево на улицу Ленина.', lengthM: 300, timeSec: 200, shapeIndex: 1, ...over });
const plan = (): PlannedRoute => ({
  profile: 'pedestrian', waypoints: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }], shape: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }], distanceM: 5200, durationSec: 3000,
  maneuvers: [man(), man({ type: 10, alert: 'Поверните направо.', verbal: 'Поверните направо на Садовую улицу.' }), man({ type: 4, instruction: 'Вы прибыли', alert: undefined, verbal: 'Вы прибыли.' })]
});

describe('какие фразы готовит Fish', () => {
  it('статические фразы: конечный набор без дублей и без чисел из замеров', () => {
    const t = staticTexts();
    expect(new Set(t).size).toBe(t.length);
    for (const must of ['Запись началась. Вперёд.', 'Перестраиваю маршрут.', 'Маршрут перестроен.', 'Вы снова на маршруте.', 'Темп в норме.', zoneText(3), zoneText(0), arrivedText()]) expect(t).toContain(must);
    expect(t.length).toBeLessThan(20);
  });
  it('маршрут: старт и манёвры на каждом пороге, пункт назначения — отдельной статической фразой', () => {
    const t = routeTexts(plan());
    const ths = ANNOUNCE_THRESHOLDS.pedestrian;
    expect(t[0]).toBe(startText(plan()));
    for (const th of ths) { expect(t).toContain(maneuverText(man(), th, ths)); }
    expect(t.join(' ')).not.toContain('Вы прибыли');
    expect(new Set(t).size).toBe(t.length);
  });
  it('динамика никогда не совпадает с готовыми фразами', () => {
    const ready = new Set([...staticTexts(), ...routeTexts(plan())]);
    const dynamic = [
      voiceTextForTest(1, 330, false), voiceTextForTest(5, 300, true), halfText(3000, 6000), finishText({ distanceM: 5000, durationSec: 1800, hrAvg: 150 }, false),
      offRouteText(120, 90), offRouteText(15, 270)
    ];
    for (const d of dynamic) expect(ready.has(d), d).toBe(false);
    // темп: сообщения коуч-логики, кроме «Темп в норме.», содержат фактический темп и поэтому не готовятся
    let st = initialCoachState(); const said: string[] = [];
    for (let t = 0; t <= 200_000; t += 5000) {
      const r = coachStep({ maxHr: 0, targetPaceSecPerKm: 300, plannedM: null, bike: false }, st, { t, distanceM: 400 + t / 10, movingSec: 100 + t / 1000, paceSecPerKm: 400, hrBpm: null });
      st = r.state; said.push(...r.say);
    }
    expect(said.length).toBeGreaterThan(0);
    for (const s of said) expect(ready.has(s), s).toBe(false);
  });
});

// ---------- пак ----------
const CFG: TtsConfig = { url: 'http://127.0.0.1:8080', hasKey: true, keyHint: '••••1234', keySource: 'app', format: 'mp3', ffmpeg: true, params: { temperature: 0.7, topP: 0.7, repetitionPenalty: 1.2, chunkLength: 200, seed: null } };

function packRig(over: { cfg?: Partial<TtsConfig>; failKeys?: string[]; fatalAfter?: number; downloadFail?: boolean } = {}) {
  const files = new Map<string, number>();
  const sent: { key: string; text: string }[][] = [];
  const manifest = new Manifest(memKV());
  let cfg = { ...CFG, ...over.cfg };
  const store: AudioStoreApi = {
    available: true,
    put: async (n, b) => { files.set(n, b.size); }, has: async (n) => files.has(n), open: async () => null,
    remove: async (n) => { files.delete(n); }, list: async () => [...files].map(([name, bytes]) => ({ name, bytes }))
  };
  const d: PackDeps = {
    store, manifest, getConfig: async () => cfg,
    stream: async function* (_v, phrases): AsyncGenerator<PackEvent> {
      sent.push(phrases);
      yield { type: 'start', total: phrases.length };
      let n = 0;
      for (const p of phrases) {
        if (over.fatalAfter !== undefined && n >= over.fatalAfter) { yield { type: 'error', key: p.key, message: 'ПК выключен' }; yield { type: 'fatal', message: 'ПК выключен' }; return; }
        if (over.failKeys?.includes(p.key)) { yield { type: 'error', key: p.key, message: 'сбой' }; continue; }
        n++;
        yield { type: 'item', key: p.key, hash: 'h' + p.key, ext: 'mp3', bytes: 11, duration: 1.5, cached: false };
      }
      yield { type: 'done', ok: n, failed: 0 };
    },
    download: async () => { if (over.downloadFail) throw new Error('нет сети'); return new Blob([new Uint8Array(11)]); }
  };
  return { d, files, sent, manifest, setCfg: (c: Partial<TtsConfig>) => { cfg = { ...cfg, ...c }; } };
}

describe('подготовка пака', () => {
  const texts = ['Запись началась. Вперёд.', 'Через 40 метров, поверните налево.', 'Темп в норме.'];

  it('собирает, сохраняет файлы и заполняет манифест; числа уходят словами', async () => {
    const r = packRig();
    const progress: number[] = [];
    const res = await preparePhrases('v1', texts, { onProgress: (p) => progress.push(p.done) }, r.d);
    expect(res).toMatchObject({ ok: 3, failed: 0, skipped: 0, total: 3, aborted: false });
    expect(r.files.size).toBe(3);
    expect(r.sent[0].map((p) => p.text)).toContain('Через сорок метров, поверните налево.');
    for (const t of texts) expect(r.manifest.lookup('v1', t)?.name).toMatch(/^h.+\.mp3$/);
    expect(progress.at(-1)).toBe(3);
  });

  it('идемпотентна: повтор ничего не запрашивает', async () => {
    const r = packRig();
    await preparePhrases('v1', texts, {}, r.d);
    r.sent.length = 0;
    const res = await preparePhrases('v1', texts, {}, r.d);
    expect(res).toMatchObject({ ok: 0, skipped: 3 }); expect(r.sent.length).toBe(0);
  });

  it('потерянный файл подготавливается заново', async () => {
    const r = packRig();
    await preparePhrases('v1', texts, {}, r.d);
    const lost = r.manifest.lookup('v1', texts[1])!.name;
    r.files.delete(lost); r.sent.length = 0;
    const res = await preparePhrases('v1', texts, {}, r.d);
    expect(res).toMatchObject({ ok: 1, skipped: 2 }); expect(r.sent[0]).toHaveLength(1);
  });

  it('прерванная сборка продолжается с недостающих', async () => {
    const r = packRig({ fatalAfter: 1 });
    const first = await preparePhrases('v1', texts, {}, r.d);
    expect(first.fatal).toBe('ПК выключен'); expect(first.ok).toBe(1);
    const r2 = { ...r.d, stream: packRig().d.stream };
    r.sent.length = 0;
    const second = await preparePhrases('v1', texts, {}, r2);
    expect(second).toMatchObject({ ok: 2, skipped: 1, failed: 0 }); expect(second.fatal).toBeUndefined();
  });

  it('частичные сбои считаются, остальное готово', async () => {
    const r = packRig({ failKeys: [textKey('Темп в норме.')] });
    const res = await preparePhrases('v1', texts, {}, r.d);
    expect(res).toMatchObject({ ok: 2, failed: 1 }); expect(r.manifest.lookup('v1', 'Темп в норме.')).toBeNull();
  });

  it('сбой скачивания файла не ломает остальное', async () => {
    const res = await preparePhrases('v1', texts, {}, packRig({ downloadFail: true }).d);
    expect(res).toMatchObject({ ok: 0, failed: 3 });
  });

  it('смена параметров и голоса инвалидирует пак и удаляет старые файлы', async () => {
    const r = packRig();
    await preparePhrases('v1', texts, {}, r.d);
    expect(r.files.size).toBe(3);
    r.setCfg({ params: { ...CFG.params, temperature: 0.4 } });
    const res = await preparePhrases('v1', ['Темп в норме.'], {}, r.d);
    expect(res.ok).toBe(1); expect(r.files.size).toBe(1);                 // старые три файла удалены, один новый
    expect(r.manifest.lookup('v1', texts[0])).toBeNull();
    await preparePhrases('v2', ['Темп в норме.'], {}, r.d);               // другой голос: прежние записи убраны
    expect(r.manifest.lookup('v1', 'Темп в норме.')).toBeNull(); expect(r.manifest.lookup('v2', 'Темп в норме.')).not.toBeNull();
  });

  it('прерывание через signal', async () => {
    const r = packRig();
    const ctl = new AbortController();
    const res = await preparePhrases('v1', texts, { signal: ctl.signal, onProgress: (p) => { if (p.done >= 1) ctl.abort(); } }, r.d);
    expect(res.aborted).toBe(true); expect(res.ok).toBeLessThan(3);
  });

  it('большой набор режется на пачки не больше BATCH', async () => {
    const r = packRig();
    const many = Array.from({ length: BATCH * 2 + 5 }, (_, i) => `Фраза номер ${i}.`);
    const res = await preparePhrases('v1', many, {}, r.d);
    expect(res.ok).toBe(many.length); expect(r.sent.map((s) => s.length)).toEqual([BATCH, BATCH, 5]);
  });

  it('сервер недоступен при чтении настроек — понятная ошибка, ничего не сохранено', async () => {
    const r = packRig();
    r.d.getConfig = async () => { throw new Error('Устройство не подключено'); };
    const res = await preparePhrases('v1', texts, {}, r.d);
    expect(res.fatal).toBe('Устройство не подключено'); expect(r.files.size).toBe(0);
  });

  it('нет хранилища на устройстве', async () => {
    const r = packRig();
    r.d.store = { ...r.d.store, available: false };
    expect((await preparePhrases('v1', texts, {}, r.d)).fatal).toMatch(/некуда/);
  });

  it('маршрутный пак пропускается без Fish или без голоса и не бросает ошибок', async () => {
    const r = packRig();
    expect(await prepareRoutePack(plan(), { ttsEngine: 'system', ttsVoiceId: 'v1' }, {}, r.d)).toBe('skipped');
    expect(await prepareRoutePack(plan(), { ttsEngine: 'fish', ttsVoiceId: '' }, {}, r.d)).toBe('skipped');
    expect(r.sent.length).toBe(0);
    const res = await prepareRoutePack(plan(), { ttsEngine: 'fish', ttsVoiceId: 'v1' }, {}, r.d);
    expect(res).toMatchObject({ failed: 0 });
    expect(r.manifest.lookup('v1', startText(plan()))).not.toBeNull();
    expect(r.manifest.lookup('v1', 'Перестраиваю маршрут.')).not.toBeNull(); // статические фразы тоже подготовлены
  });

  it('ПК недоступен при построении маршрута: исход «fatal», без исключений', async () => {
    const r = packRig(); r.d.getConfig = async () => { throw new Error('Сервер недоступен'); };
    const res = await prepareRoutePack(plan(), { ttsEngine: 'fish', ttsVoiceId: 'v1' }, {}, r.d);
    expect(typeof res === 'object' && res.fatal).toBe('Сервер недоступен');
  });
});
