import { describe, expect, it } from 'vitest';
import { formatCodeInput, normalizeCode } from '../../src/nearby/code';
import { computeSas, extractFingerprint, filterRemoteSdp, formatSas, isLocalAddress } from '../../src/nearby/sdp';
import { encodeWire, parseWire, quickText, MAX_TEXT } from '../../src/nearby/messages';
import { buildPresence, describePresence, isStale, presenceKey, PresenceSender, restLeft, sanitizePresence, type PresenceWorkout, type RemotePresence } from '../../src/nearby/presence';

describe('код комнаты', () => {
  it('нормализация и ввод', () => {
    expect(normalizeCode('k7m4 p2qx')).toBe('K7M4-P2QX');
    expect(normalizeCode('K7M4P2QX')).toBe('K7M4-P2QX');
    expect(normalizeCode('K7M4-P2Q1')).toBeNull(); // 1 в алфавите нет
    expect(normalizeCode('K7M4-P2QO')).toBeNull(); // и O тоже
    expect(normalizeCode('')).toBeNull();
    expect(formatCodeInput('k7m4p2qxzz')).toBe('K7M4-P2QX');
    expect(formatCodeInput('k7m')).toBe('K7M');
    expect(formatCodeInput('k7m4p')).toBe('K7M4-P');
  });
});

const fpA = 'AA:BB:CC:DD';
const fpB = '11:22:33:44';
const sdp = (fp: string, extra = '') => `v=0\r\na=fingerprint:sha-256 ${fp}\r\n${extra}`;

describe('SDP и код сверки', () => {
  it('отпечаток извлекается и нормализуется', () => {
    expect(extractFingerprint(sdp(fpA))).toBe('sha-256 aa:bb:cc:dd');
    expect(extractFingerprint('v=0\r\n')).toBeNull();
  });

  it('SAS одинаков у обеих сторон и состоит из 6 цифр', async () => {
    const host = await computeSas(sdp(fpA), sdp(fpB));
    const guest = await computeSas(sdp(fpB), sdp(fpA));
    expect(host).toBe(guest);
    expect(host).toMatch(/^\d{6}$/);
    expect(formatSas('048213')).toBe('048 213');
  });

  it('при подмене отпечатка код меняется', async () => {
    const real = await computeSas(sdp(fpA), sdp(fpB));
    let different = 0;
    for (let i = 0; i < 20; i++) if ((await computeSas(sdp(fpA), sdp(`EE:${i}:FF`))) !== real) different++;
    expect(different).toBe(20);
  });

  it('без отпечатка код не считается', async () => {
    await expect(computeSas('v=0', sdp(fpA))).rejects.toThrow();
  });

  it('локальные адреса отличаются от публичных', () => {
    for (const a of ['192.168.43.1', '10.1.2.3', '172.16.0.5', '172.31.9.9', '169.254.1.1', '100.101.102.103', '127.0.0.1', 'fe80::1', 'fd12::1', '::1', 'a1b2-c3.local']) expect(isLocalAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '100.63.0.1', '203.0.113.9', '2001:db8::1', '2a00:1450::1', 'example.com']) expect(isLocalAddress(a), a).toBe(false);
  });

  it('из чужого SDP убираются публичные, srflx и relay кандидаты', () => {
    const src = [
      'v=0',
      'a=fingerprint:sha-256 AA:BB',
      'a=candidate:1 1 udp 2122260223 192.168.43.12 54321 typ host',
      'a=candidate:2 1 udp 2122260223 abcd-ef01.local 54322 typ host',
      'a=candidate:3 1 udp 1686052607 203.0.113.9 54323 typ srflx raddr 192.168.43.12 rport 54321',
      'a=candidate:4 1 udp 41885439 8.8.8.8 3478 typ relay',
      'a=candidate:5 1 udp 2122194687 2a00:1450::1 54324 typ host',
      'a=end-of-candidates'
    ].join('\r\n');
    const out = filterRemoteSdp(src);
    expect(out).toContain('192.168.43.12');
    expect(out).toContain('abcd-ef01.local');
    expect(out).not.toContain('203.0.113.9');
    expect(out).not.toContain('8.8.8.8');
    expect(out).not.toContain('2a00:1450');
    expect(out).toContain('a=fingerprint');
    expect(out).toContain('a=end-of-candidates');
  });
});

describe('протокол канала', () => {
  it('разбор: нормальные сообщения проходят, лишнее отбрасывается', () => {
    expect(parseWire('{"k":"chat","text":"  привет  мир "}')).toEqual({ k: 'chat', text: 'привет мир' });
    expect(parseWire('{"k":"call","junk":1}')).toEqual({ k: 'call' });
    expect(parseWire('{"k":"hello","name":"Аня","proto":1,"app":"0.4.0","x":1}')).toEqual({ k: 'hello', name: 'Аня', proto: 1, app: '0.4.0', got: false });
    for (const bad of ['', 'x', '{}', '[]', 'null', '{"k":"chat"}', '{"k":"chat","text":"   "}', '{"k":"hello","name":"","proto":1}', '{"k":"hello","name":"a","proto":"1"}', '{"k":"presence","p":{"v":2}}', '{"k":"nope"}'])
      expect(parseWire(bad), bad).toBeNull();
    expect(parseWire('x'.repeat(3000))).toBeNull();
    expect(parseWire(42)).toBeNull();
  });

  it('текст обрезается, управляющие символы убираются', () => {
    const w = parseWire(JSON.stringify({ k: 'chat', text: 'a\u0000b\u0007c' + 'я'.repeat(400) }));
    expect(w && w.k === 'chat' && w.text.length).toBe(MAX_TEXT);
    expect(w && w.k === 'chat' && w.text.startsWith('abc')).toBe(true);
  });

  it('кодирование и разбор взаимно обратны', () => {
    expect(parseWire(encodeWire({ k: 'bye' }))).toEqual({ k: 'bye' });
  });

  it('быстрая фраза «Подстрахуй» знает упражнение только если оно не скрыто', () => {
    const p = { v: 1 as const, phase: 'working' as const, exerciseName: 'Жим лёжа', updatedAt: 1 };
    expect(quickText('spot', p)).toBe('Подстрахуй: Жим лёжа');
    expect(quickText('spot', { ...p, hidden: true })).toBe('Подстрахуй');
    expect(quickText('spot', { ...p, phase: 'idle' })).toBe('Подстрахуй');
    expect(quickText('spot', null)).toBe('Подстрахуй');
    expect(quickText('ready', p)).toBe('Готов');
  });
});

const w = (over: Partial<PresenceWorkout> = {}): PresenceWorkout => ({
  title: 'Грудь и трицепс',
  exercises: [
    { name: 'Жим лёжа', cardio: false, cardioDone: false, sets: [{ done: true, completedAt: 100 }, { done: true, completedAt: 200 }, { done: false }, { done: false }] },
    { name: 'Разводка', cardio: false, cardioDone: false, sets: [{ done: false }, { done: false }] }
  ],
  ...over
});

describe('presence: построение', () => {
  it('нет тренировки — idle; тумблер выключен — только hidden', () => {
    expect(buildPresence({ workout: null, rest: null, share: true, now: 5 })).toEqual({ v: 1, phase: 'idle', updatedAt: 5 });
    expect(buildPresence({ workout: w(), rest: null, share: false, now: 5 })).toEqual({ v: 1, phase: 'idle', hidden: true, updatedAt: 5 });
  });

  it('в работе: первый невыполненный подход первого неоконченного упражнения', () => {
    const p = buildPresence({ workout: w(), rest: null, share: true, now: 1 });
    expect(p).toMatchObject({ phase: 'working', exerciseName: 'Жим лёжа', setIndex: 3, setTotal: 4, workoutTitle: 'Грудь и трицепс' });
    expect(p.restRemainingSec).toBeUndefined();
  });

  it('на отдыхе: упражнение последнего выполненного подхода и остаток таймера', () => {
    const p = buildPresence({ workout: w(), rest: { remainingSec: 71.2, totalSec: 90 }, share: true, now: 1 });
    expect(p).toMatchObject({ phase: 'resting', exerciseName: 'Жим лёжа', setIndex: 2, setTotal: 4, restRemainingSec: 72, restTotalSec: 90 });
  });

  it('закончилось упражнение — следующее', () => {
    const wk = w();
    wk.exercises[0].sets.forEach((s) => { s.done = true; s.completedAt = 300; });
    expect(buildPresence({ workout: wk, rest: null, share: true, now: 1 })).toMatchObject({ exerciseName: 'Разводка', setIndex: 1, setTotal: 2 });
  });

  it('всё выполнено, но тренировка идёт — остаётся на последнем упражнении', () => {
    const wk = w();
    wk.exercises.forEach((e) => e.sets.forEach((s) => { s.done = true; s.completedAt = 1; }));
    expect(buildPresence({ workout: wk, rest: null, share: true, now: 1 })).toMatchObject({ phase: 'working', exerciseName: 'Разводка', setIndex: 2, setTotal: 2 });
  });

  it('кардио без подходов: только название; пустая тренировка — просто «работает»', () => {
    const run = w({ exercises: [{ name: 'Бег', cardio: true, cardioDone: false, sets: [] }] });
    const p = buildPresence({ workout: run, rest: null, share: true, now: 1 });
    expect(p).toMatchObject({ phase: 'working', exerciseName: 'Бег' });
    expect(p.setIndex).toBeUndefined();
    expect(buildPresence({ workout: w({ exercises: [] }), rest: null, share: true, now: 1 })).toMatchObject({ phase: 'working' });
  });

  it('вес, повторы и заметки в presence не попадают', () => {
    const wk = w();
    (wk.exercises[0].sets[0] as Record<string, unknown>).weight = 100;
    (wk.exercises[0].sets[0] as Record<string, unknown>).note = 'секрет';
    const json = JSON.stringify(buildPresence({ workout: wk, rest: { remainingSec: 5, totalSec: 90 }, share: true, now: 1 }));
    expect(json).not.toContain('100');
    expect(json).not.toContain('секрет');
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(['exerciseName', 'phase', 'restRemainingSec', 'restTotalSec', 'setIndex', 'setTotal', 'updatedAt', 'v', 'workoutTitle']);
  });

  it('таймер на нуле — уже не отдых', () => {
    expect(buildPresence({ workout: w(), rest: { remainingSec: 0, totalSec: 90 }, share: true, now: 1 }).phase).toBe('working');
  });
});

describe('presence: отправка и приём', () => {
  const base = { v: 1 as const, phase: 'resting' as const, exerciseName: 'Жим', setIndex: 2, setTotal: 4, restRemainingSec: 90, restTotalSec: 90, updatedAt: 0 };

  it('шлём при смене, не шлём при тиках таймера, шлём при сдвиге таймера', () => {
    const s = new PresenceSender();
    expect(s.shouldSend(base, 0)).toBe(true);
    s.mark(base, 0);
    expect(s.shouldSend({ ...base, restRemainingSec: 89, updatedAt: 1000 }, 1000)).toBe(false);
    expect(s.shouldSend({ ...base, restRemainingSec: 60, updatedAt: 30000 }, 30000)).toBe(false); // идёт по расписанию
    expect(s.shouldSend({ ...base, restRemainingSec: 75, updatedAt: 1000 }, 1000)).toBe(true);    // «−15» на таймере
    expect(s.shouldSend({ ...base, setIndex: 3 }, 1000)).toBe(true);
    s.reset();
    expect(s.shouldSend(base, 5000)).toBe(true);
    expect(presenceKey(base)).not.toBe(presenceKey({ ...base, exerciseName: 'Тяга' }));
  });

  it('чистка входящих: неизвестные поля, диапазоны, типы', () => {
    expect(sanitizePresence(null)).toBeNull();
    expect(sanitizePresence({ v: 1, phase: 'dancing' })).toBeNull();
    expect(sanitizePresence({ v: 2, phase: 'idle' })).toBeNull();
    const p = sanitizePresence({ v: 1, phase: 'resting', exerciseName: ' Присед\u0000 ', setIndex: 9, setTotal: 3, restRemainingSec: 1e9, weight: 100, __proto__: { x: 1 }, updatedAt: 'x' });
    expect(p).toEqual({ v: 1, phase: 'resting', exerciseName: 'Присед', setIndex: 3, setTotal: 3, restRemainingSec: 3600, updatedAt: 0 });
  });

  it('остаток отдыха считается по нашим часам, устаревшее не рисуется живым таймером', () => {
    const r: RemotePresence = { p: { ...base, restRemainingSec: 72 }, receivedAt: 1_000 };
    expect(restLeft(r, 1_000)).toBe(72);
    expect(restLeft(r, 11_000)).toBe(62);
    expect(restLeft(r, 999_000)).toBe(0);
    expect(describePresence(r, 11_000)).toMatchObject({ text: 'Жим · подход 2/4 · отдых 1:02', short: 'отдыхает 1:02', stale: false });
    expect(isStale(r, 31_001)).toBe(true);
    const old = describePresence(r, 40_000);
    expect(old.stale).toBe(true);
    expect(old.text).not.toMatch(/\d:\d\d/);
  });

  it('описания других состояний', () => {
    const at = (p: Partial<RemotePresence['p']>): RemotePresence => ({ p: { v: 1, phase: 'working', updatedAt: 0, ...p }, receivedAt: 0 });
    expect(describePresence(at({ exerciseName: 'Жим лёжа', setIndex: 2, setTotal: 4 }), 1000)).toMatchObject({ text: 'Жим лёжа · подход 2/4', short: 'Жим лёжа 2/4' });
    expect(describePresence(at({}), 1000).text).toBe('тренируется');
    expect(describePresence(at({ phase: 'idle' }), 1000).text).toBe('не на тренировке');
    expect(describePresence(at({ phase: 'idle', hidden: true }), 1000).text).toBe('не показывает, что делает');
  });
});
