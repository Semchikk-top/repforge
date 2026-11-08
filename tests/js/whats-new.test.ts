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
  it('пропущено много версий: не больше трёх свежих', () => {
    expect(entriesToShow('0.1.0', '1.4.0', all).map((e) => e.version)).toEqual(['1.4.0', '1.3.0', '1.2.0']);
  });
  it('в журнале есть запись для текущей версии 1.2.0 и у неё есть пункты', () => {
    const cur = WHATS_NEW.find((e) => e.version === '1.2.0');
    expect(cur?.items.length).toBeGreaterThan(0);
  });
});
