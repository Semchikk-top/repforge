import { describe, expect, it } from 'vitest';
import { estimateMaxHr, validHr, zoneFor, zoneRanges } from '../../src/cardio/hr';
import { platesPerSide } from '../../src/domain/plates';

describe('пульсовые зоны', () => {
  it('оценка максимума и границы зон', () => {
    expect(estimateMaxHr(30)).toBe(187);
    expect(zoneFor(100, 200)?.n).toBe(1);
    expect(zoneFor(120, 200)?.n).toBe(2);
    expect(zoneFor(159, 200)?.n).toBe(3);
    expect(zoneFor(160, 200)?.n).toBe(4);
    expect(zoneFor(200, 200)?.n).toBe(5);
    expect(zoneFor(80, 200)).toBeNull();
    expect(zoneFor(150, 0)).toBeNull();
    expect(zoneFor(NaN, 190)).toBeNull();
  });
  it('диапазоны и проверка ввода', () => {
    const r = zoneRanges(200);
    expect(r[3]).toMatchObject({ lo: 160, hi: 180 });
    expect(r[4].hi).toBe(200);
    expect(validHr(150)).toBe(true);
    expect(validHr(20)).toBe(false);
    expect(validHr(150.5)).toBe(false);
  });
});

describe('калькулятор блинов из выбранного набора', () => {
  it('использует только имеющиеся блины и честно говорит, чего не хватило', () => {
    expect(platesPerSide(100, 20, [20, 10, 5])).toMatchObject({ perSide: [20, 20], achieved: 100, missing: 0 });
    const r = platesPerSide(72.5, 20, [20, 10]);   // 2,5 кг на сторону взять неоткуда
    expect(r.perSide.every((p) => p === 20 || p === 10)).toBe(true);
    expect(r.missing).toBeGreaterThan(0);
  });
});
