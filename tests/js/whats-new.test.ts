import { describe, expect, it } from 'vitest';
import { compareVersions, entriesToShow, WHATS_NEW, type WhatsNewEntry } from '../../src/whatsNew';

const E = (version: string): WhatsNewEntry => ({ version, title: version, items: ['x'] });
const all = [E('1.0.0'), E('1.1.0'), E('1.2.0'), E('1.3.0'), E('1.4.0')];

describe('сравнение версий', () => {
  it('числовое, а не строковое: 1.10.0 новее 1.9.0; суффикс сборки игнорируется', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0-beta', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
  });
});

describe('что показать после обновления', () => {
  it('записи новее виденной и не новее текущей, свежие первыми', () => {
    expect(entriesToShow('1.1.0', '1.3.0', all).map((e) => e.version)).toEqual(['1.3.0', '1.2.0']);
  });
  it('та же версия: ничего; приложение откатили назад: ничего', () => {
    expect(entriesToShow('1.2.0', '1.2.0', all)).toEqual([]);
    expect(entriesToShow('1.4.0', '1.2.0', all)).toEqual([]);
  });
  it('версия неизвестна: только запись текущей версии', () => {
    expect(entriesToShow(null, '1.3.0', all).map((e) => e.version)).toEqual(['1.3.0']);
    expect(entriesToShow(null, '1.2.5', all)).toEqual([]);
  });
  it('пропущено много версий: показываются все записи новее lastSeen, свежие первыми', () => {
    expect(entriesToShow('0.1.0', '1.4.0', all).map((e) => e.version)).toEqual(['1.4.0', '1.3.0', '1.2.0', '1.1.0', '1.0.0']);
  });
  it('обновление с 1.0.0 показывает всю историю 1.1–1.6', () => {
    expect(entriesToShow('1.0.0', '1.6.0').map((e) => e.version)).toEqual(['1.6.0', '1.5.0', '1.4.0', '1.3.0', '1.2.0', '1.1.0']);
  });
  it('неизвестная версия показывает только текущую 1.6.0', () => {
    expect(entriesToShow(null, '1.6.0').map((e) => e.version)).toEqual(['1.6.0']);
  });
  it('в журнале есть записи текущих версий 1.6.0, 1.5.0 и 1.1.0, у каждой есть пункты', () => {
    for (const version of ['1.6.0', '1.5.0', '1.1.0']) {
      const cur = WHATS_NEW.find((e) => e.version === version);
      expect(cur?.items.length, version).toBeGreaterThan(0);
    }
  });
});
