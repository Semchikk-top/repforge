import { describe, expect, it } from 'vitest';
// @ts-expect-error: служебный .mjs без типов
import { appId, BASE_APP_ID } from '../../scripts/android-app-id.mjs';

describe('идентификатор Android', () => {
  it('обычная сборка оставляет базовый идентификатор', () => {
    expect(appId(false)).toBe(BASE_APP_ID);
    expect(BASE_APP_ID).toBe('app.repforge.workout');
  });
  it('сборка с --debug добавляет .debug в конец', () => {
    expect(appId(true)).toBe('app.repforge.workout.debug');
  });
});
