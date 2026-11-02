import { describe, expect, it } from 'vitest';
import { LEGAL, legalFilled } from '../../src/legal/config';

describe('юридические данные для публикации', () => {
  it('все заглушки заполнены', () => {
    expect(legalFilled()).toBe(true);
  });

  it('публичные ссылки ведут на https', () => {
    for (const url of [LEGAL.privacyUrl, LEGAL.githubUrl, LEGAL.supportUrl]) {
      expect(url).toMatch(/^https:\/\/[^<>\s]+$/);
    }
  });

  it('политика содержит оператора и контакт', () => {
    expect(LEGAL.operator).toContain('ИНН 421815687221');
    expect(LEGAL.email).toContain('@');
    expect(LEGAL.updated).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });
});
