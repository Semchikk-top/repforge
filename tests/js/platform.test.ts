import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, setPlatform } from '../../src/platform';
import { createWebPlatform, webGeo, webLifecycle, webNotifications, webWakeLock } from '../../src/platform/web';
import type { Platform } from '../../src/platform/types';

const shown: Array<{ title: string; opts: unknown }> = [];
class FakeNotification {
  static permission = 'granted';
  constructor(title: string, opts?: unknown) { shown.push({ title, opts }); }
}

function stubBrowser(extra: Record<string, unknown> = {}) {
  shown.length = 0;
  FakeNotification.permission = 'granted';
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('window', { Notification: FakeNotification, isSecureContext: true, setTimeout: (f: () => void, ms: number) => globalThis.setTimeout(f, ms) });
  vi.stubGlobal('navigator', { ...extra });
}

describe('слой платформы: подмена реализации', () => {
  afterEach(() => setPlatform(createWebPlatform('test')));

  it('по умолчанию это браузер', () => {
    expect(platform.info).toEqual({ native: false, os: 'web', version: 'test' });
  });

  it('setPlatform меняет реализацию для уже импортированного platform', () => {
    const vibrate = vi.fn();
    const fake: Platform = { ...createWebPlatform('x'), info: { native: true, os: 'android', version: 'x' }, haptics: { vibrate } };
    setPlatform(fake);
    platform.haptics.vibrate([1, 2]);
    expect(vibrate).toHaveBeenCalledWith([1, 2]);
    expect(platform.info.native).toBe(true);
  });
});

describe('веб-уведомления', () => {
  beforeEach(() => { vi.useFakeTimers(); stubBrowser(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('permission и show учитывают разрешение', async () => {
    expect(webNotifications.permission()).toBe('granted');
    await webNotifications.show({ title: 'A', body: 'b', tag: 't' });
    expect(shown.map((s) => s.title)).toEqual(['A']);
    FakeNotification.permission = 'denied';
    await webNotifications.show({ title: 'B', body: 'b', tag: 't' });
    expect(shown).toHaveLength(1);
  });

  it('в браузере фоновых уведомлений и точных будильников нет, кнопки не приходят', async () => {
    expect(webNotifications.background).toBe(false);
    expect(await webNotifications.exactAlarm()).toBe('unsupported');
    expect(await webNotifications.requestExactAlarm()).toBe('unsupported');
    const cb = vi.fn();
    webNotifications.onAction(cb)();
    expect(cb).not.toHaveBeenCalled();
  });

  it('без Notification — unsupported', () => {
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout });
    expect(webNotifications.permission()).toBe('unsupported');
  });

  it('schedule срабатывает в назначенное время, а не раньше', async () => {
    await webNotifications.schedule('rest', Date.now() + 5000, { title: 'Отдых', body: 'пора', tag: 'rest' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(shown).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(shown.map((s) => s.title)).toEqual(['Отдых']);
  });

  it('повторный schedule с тем же id заменяет прежний, cancel отменяет', async () => {
    await webNotifications.schedule('x', Date.now() + 1000, { title: 'старое', body: '', tag: 'x' });
    await webNotifications.schedule('x', Date.now() + 3000, { title: 'новое', body: '', tag: 'x' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(shown).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(shown.map((s) => s.title)).toEqual(['новое']);

    await webNotifications.schedule('y', Date.now() + 1000, { title: 'отменённое', body: '', tag: 'y' });
    await webNotifications.cancel('y');
    await vi.advanceTimersByTimeAsync(5000);
    expect(shown.map((s) => s.title)).toEqual(['новое']);
  });
});

describe('веб: экран и GPS', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('wakeLock отпускается возвращённой функцией; без поддержки — no-op', async () => {
    const release = vi.fn();
    stubBrowser({ wakeLock: { request: vi.fn(async () => ({ release })) } });
    const off = await webWakeLock.acquire();
    off();
    expect(release).toHaveBeenCalledTimes(1);

    stubBrowser({});
    const noop = await webWakeLock.acquire();
    expect(() => noop()).not.toThrow();

    stubBrowser({ wakeLock: { request: vi.fn(async () => { throw new Error('battery saver'); }) } });
    expect(() => void webWakeLock.acquire().then((f) => f())).not.toThrow();
  });

  it('в браузере сканера QR нет: ссылку открывает обычная камера телефона', async () => {
    const { webScanner } = await import('../../src/platform/web');
    expect(webScanner.available).toBe(false);
    expect(await webScanner.scanQr()).toBeNull();
  });

  it('geo: в браузере фоновой записи нет', () => {
    expect(webGeo.background).toBe(false);
  });

  it('geo: причины недоступности', () => {
    stubBrowser({});
    expect(webGeo.unsupportedReason()).toMatch(/не умеет/);
    stubBrowser({ geolocation: {} });
    vi.stubGlobal('window', { isSecureContext: false });
    expect(webGeo.unsupportedReason()).toMatch(/https/);
    vi.stubGlobal('window', { isSecureContext: true });
    expect(webGeo.unsupportedReason()).toBeNull();
  });

  it('geo.watch переводит точки и ошибки в общий вид и останавливается', () => {
    let ok: (p: unknown) => void = () => {};
    let bad: (e: unknown) => void = () => {};
    const clearWatch = vi.fn();
    stubBrowser({ geolocation: { watchPosition: (a: typeof ok, b: typeof bad) => { ok = a; bad = b; return 7; }, clearWatch } });
    const fixes: unknown[] = [], errors: string[] = [];
    const h = webGeo.watch((f) => fixes.push(f), (k) => errors.push(k));
    ok({ timestamp: 1000, coords: { latitude: 55.1, longitude: 37.2, accuracy: 5, altitude: null } });
    bad({ code: 1, PERMISSION_DENIED: 1 });
    bad({ code: 2, PERMISSION_DENIED: 1 });
    expect(fixes).toEqual([{ t: 1000, lat: 55.1, lon: 37.2, acc: 5, ele: null }]);
    expect(errors).toEqual(['denied', 'unavailable']);
    h.stop();
    expect(clearWatch).toHaveBeenCalledWith(7);
  });
});

describe('веб: жизненный цикл', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('onResume реагирует только на «видимо», onPause — только на «скрыто», отписка работает', () => {
    const handlers = new Set<() => void>();
    const doc = {
      visibilityState: 'visible',
      addEventListener: (_: string, h: () => void) => handlers.add(h),
      removeEventListener: (_: string, h: () => void) => handlers.delete(h)
    };
    vi.stubGlobal('document', doc);
    const resume = vi.fn(), pause = vi.fn();
    const offR = webLifecycle.onResume(resume);
    const offP = webLifecycle.onPause(pause);
    const fire = (state: string) => { doc.visibilityState = state; handlers.forEach((h) => h()); };

    fire('hidden');
    expect([resume.mock.calls.length, pause.mock.calls.length]).toEqual([0, 1]);
    fire('visible');
    expect([resume.mock.calls.length, pause.mock.calls.length]).toEqual([1, 1]);
    offR(); offP();
    fire('hidden'); fire('visible');
    expect([resume.mock.calls.length, pause.mock.calls.length]).toEqual([1, 1]);
    expect(handlers.size).toBe(0);
  });

  it('в браузере кнопка «Назад» и deep link не вызываются', () => {
    const cb = vi.fn();
    webLifecycle.onBackButton(cb)();
    webLifecycle.onOpenUrl(cb)();
    expect(cb).not.toHaveBeenCalled();
  });
});
