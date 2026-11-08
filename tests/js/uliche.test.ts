import { describe, expect, it } from 'vitest';
// @ts-expect-error: служебный .mjs без типов
import { ensureTtsQueries } from '../../scripts/android-manifest.mjs';
import { indexRoute, routePart } from '../../src/cardio/nav';
import { parsePace, parseSpeedKmh, targetFromText } from '../../src/cardio/target';
import { DEFAULT_SETTINGS } from '../../src/domain/types';

const MANIFEST = '<?xml version="1.0"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <application android:usesCleartextTraffic="false"></application>\n</manifest>\n';

describe('манифест Android: озвучка', () => {
  it('добавляет queries один раз и не ломает остальное', () => {
    const once = ensureTtsQueries(MANIFEST) as string;
    expect(once).toContain('android.intent.action.TTS_SERVICE');
    expect(once).toContain('usesCleartextTraffic="false"');
    expect(ensureTtsQueries(once)).toBe(once);
    expect(once.trim().endsWith('</manifest>')).toBe(true);
  });
  it('дополняет уже существующий блок queries', () => {
    const withQ = MANIFEST.replace('</manifest>', '    <queries><package android:name="x"/></queries>\n</manifest>');
    const out = ensureTtsQueries(withQ) as string;
    expect(out.match(/<queries>/g)).toHaveLength(1);
    expect(out).toContain('TTS_SERVICE'); expect(out).toContain('android:name="x"');
  });
  it('на повреждённом файле падает громко', () => { expect(() => ensureTtsQueries('<manifest>')).toThrow(); });
});

describe('цель по темпу и скорости', () => {
  it('темп мин/км', () => {
    expect(parsePace('6:00')).toBe(360); expect(parsePace('5.30')).toBe(330); expect(parsePace('5 30')).toBe(330);
    for (const bad of ['', 'abc', '6:75', '1:00', '30:00', '6']) expect(parsePace(bad)).toBeNull();
  });
  it('скорость км/ч → секунды на километр', () => {
    expect(parseSpeedKmh('25')).toBe(144); expect(parseSpeedKmh('24,5')).toBe(147);
    for (const bad of ['1', '99', 'x', '']) expect(parseSpeedKmh(bad)).toBeNull();
  });
  it('пусто — цели нет', () => { expect(targetFromText('  ', false)).toBeNull(); expect(targetFromText('6:00', false)).toBe(360); expect(targetFromText('25', true)).toBe(144); });
});

describe('прочее', () => {
  it('часть маршрута для окраски пройденного', () => {
    const shape = [0, 1, 2, 3].map((i) => ({ lat: 55, lon: 37 + i * 0.001 }));
    const idx = indexRoute(shape);
    const part = routePart(idx, 0, idx.totalM / 2);
    expect(part.length).toBeGreaterThanOrEqual(3);
    expect(part[0]).toEqual(shape[0]);
    expect(routePart(idx, 50, 50)).toEqual([]);
  });
  it('голос по умолчанию выключен: включается только явно', () => {
    expect(DEFAULT_SETTINGS.voiceNav).toBe(false);
    expect(DEFAULT_SETTINGS.voiceCoach).toBe(false);
    expect(DEFAULT_SETTINGS.voiceCues).toBe(false);
  });
});
