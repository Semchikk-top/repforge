import { beforeEach, describe, expect, it, vi } from 'vitest';

// Нативные плагины подменены: проверяем наш код-обвязку, а не сам Capacitor. Реальное поведение
// (фоновые разрешения, foreground service, производители с агрессивной экономией) проверяется только на телефоне.
const h = vi.hoisted(() => ({
  listeners: new Map<string, (e: unknown) => void>(),
  remove: vi.fn(),
  exitApp: vi.fn(),
  geoCb: null as null | ((pos: unknown, err?: unknown) => void),
  geoPerm: 'granted',
  clearWatch: vi.fn(),
  watchDelay: false,
  notifPerm: 'prompt',
  qr: { requestPermissions: vi.fn(), scan: vi.fn() },
  ble: {
    initialize: vi.fn(async () => {}), isEnabled: vi.fn(async () => true), requestEnable: vi.fn(async () => {}),
    requestDevice: vi.fn(), connect: vi.fn(), startNotifications: vi.fn(), stopNotifications: vi.fn(async () => {}), disconnect: vi.fn(async () => {})
  },
  ss: { getItem: vi.fn(), setItem: vi.fn(async () => {}), remove: vi.fn(async () => true) },
  fs: { mkdir: vi.fn(async () => {}), readdir: vi.fn(), readFile: vi.fn(), deleteFile: vi.fn(async () => {}) },
  order: [] as string[],
  bgCb: null as null | ((loc?: unknown, err?: unknown) => void),
  addWatcher: vi.fn(),
  removeWatcher: vi.fn(async () => {}),
  exact: 'granted',
  actionCb: null as null | ((ev: unknown) => void),
  registerActionTypes: vi.fn(async () => {}),
  createChannel: vi.fn(async () => {}),
  removeDelivered: vi.fn(async () => {}),
  changeExact: vi.fn(async () => ({ exact_alarm: 'denied' })),
  schedule: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  keepAwake: vi.fn(async () => {}),
  allowSleep: vi.fn(async () => {}),
  writeFile: vi.fn(async (o: { path: string }) => ({ uri: 'file:///cache/' + o.path })),
  share: vi.fn(async () => {})
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' }, registerPlugin: () => ({ addWatcher: h.addWatcher, removeWatcher: h.removeWatcher }) }));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (ev: string, cb: (e: unknown) => void) => { h.listeners.set(ev, cb); return { remove: h.remove }; }),
    exitApp: h.exitApp
  }
}));
vi.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    requestPermissions: vi.fn(async () => ({ location: h.geoPerm })),
    watchPosition: vi.fn(async (_o: unknown, cb: (pos: unknown, err?: unknown) => void) => { h.geoCb = cb; return 'w1'; }),
    clearWatch: h.clearWatch
  }
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn(async () => ({ display: h.notifPerm })),
    requestPermissions: vi.fn(async () => { h.order.push('notif-permission'); return { display: 'granted' }; }),
    schedule: h.schedule,
    cancel: h.cancel,
    registerActionTypes: h.registerActionTypes,
    createChannel: h.createChannel,
    removeDeliveredNotifications: h.removeDelivered,
    checkExactNotificationSetting: vi.fn(async () => ({ exact_alarm: h.exact })),
    changeExactNotificationSetting: h.changeExact,
    addListener: vi.fn(async (_ev: string, cb: (ev: unknown) => void) => { h.actionCb = cb; return { remove: h.remove }; })
  }
}));
vi.mock('@capacitor-community/keep-awake', () => ({ KeepAwake: { keepAwake: h.keepAwake, allowSleep: h.allowSleep } }));
vi.mock('@capacitor/filesystem', () => ({ Filesystem: { writeFile: h.writeFile, mkdir: h.fs.mkdir, readdir: h.fs.readdir, readFile: h.fs.readFile, deleteFile: h.fs.deleteFile }, Directory: { Cache: 'CACHE', Data: 'DATA' }, Encoding: { UTF8: 'utf8' } }));
vi.mock('@capacitor-community/bluetooth-le', () => ({ BleClient: h.ble }));
vi.mock('@capacitor-mlkit/barcode-scanning', () => ({ BarcodeScanner: h.qr, BarcodeFormat: { QrCode: 'QR_CODE' } }));
vi.mock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: h.ss }));
vi.mock('@capacitor/share', () => ({ Share: { share: h.share } }));

import { createNativePlatform } from '../../src/platform/native';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('нативная платформа (Capacitor, плагины подменены)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.listeners.clear();
    h.order = []; h.bgCb = null;
    h.addWatcher.mockReset();
    h.addWatcher.mockImplementation(async (_o: unknown, cb: (loc?: unknown, err?: unknown) => void) => { h.order.push('add-watcher'); h.bgCb = cb; return 'bg1'; });
    h.geoCb = null; h.geoPerm = 'granted'; h.notifPerm = 'prompt'; h.exact = 'granted'; h.actionCb = null;
  });

  it('сообщает, что она нативная, и берёт разрешение на уведомления из системы', async () => {
    const p = await createNativePlatform('0.6.0');
    expect(p.info).toEqual({ native: true, os: 'android', version: '0.6.0' });
    expect(p.notifications.permission()).toBe('default');
    expect(await p.notifications.request()).toBe('granted');
    expect(p.notifications.permission()).toBe('granted');
  });

  it('«Назад»: по истории экранов, а на корне выход из приложения', async () => {
    const back = vi.fn();
    vi.stubGlobal('history', { back });
    await createNativePlatform('x');
    await flush();
    const cb = h.listeners.get('backButton')!;
    cb({ canGoBack: true });
    expect(back).toHaveBeenCalledTimes(1);
    expect(h.exitApp).not.toHaveBeenCalled();
    cb({ canGoBack: false });
    expect(h.exitApp).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('deep link и жизненный цикл доходят до подписчиков, отписка снимает слушатель', async () => {
    const p = await createNativePlatform('x');
    const urls: string[] = [], resumes = vi.fn();
    const off = p.lifecycle.onOpenUrl((u) => urls.push(u));
    p.lifecycle.onResume(resumes);
    await flush();
    h.listeners.get('appUrlOpen')!({ url: 'workout://pair?url=a&code=b' });
    h.listeners.get('resume')!({});
    expect(urls).toEqual(['workout://pair?url=a&code=b']);
    expect(resumes).toHaveBeenCalled();
    off(); await flush();
    expect(h.remove).toHaveBeenCalledTimes(1);
  });

  it('GPS: точки приводятся к общему виду, ошибка плагина — «недоступно», остановка снимает наблюдение', async () => {
    const p = await createNativePlatform('x');
    const fixes: unknown[] = [], errors: string[] = [];
    const w = p.geo.watch((f) => fixes.push(f), (k) => errors.push(k));
    await flush();
    h.geoCb!({ timestamp: 5, coords: { latitude: 1, longitude: 2, accuracy: 3, altitude: undefined } });
    h.geoCb!(null, new Error('boom'));
    expect(fixes).toEqual([{ t: 5, lat: 1, lon: 2, acc: 3, ele: null }]);
    expect(errors).toEqual(['unavailable']);
    w.stop();
    expect(h.clearWatch).toHaveBeenCalledWith({ id: 'w1' });
  });

  it('GPS: отказ в разрешении — «denied» без запуска наблюдения; stop до готовности не оставляет хвостов', async () => {
    h.geoPerm = 'denied';
    const p = await createNativePlatform('x');
    const errors: string[] = [];
    p.geo.watch(() => {}, (k) => errors.push(k));
    await flush();
    expect(errors).toEqual(['denied']);
    expect(h.geoCb).toBeNull();

    h.geoPerm = 'granted';
    const w = p.geo.watch(() => {}, () => {});
    w.stop(); // остановили раньше, чем плагин вернул идентификатор
    await flush();
    expect(h.clearWatch).toHaveBeenCalledWith({ id: 'w1' });
  });

  it('уведомления: schedule/cancel используют один и тот же числовой id; время передаётся как Date', async () => {
    const p = await createNativePlatform('x');
    const at = Date.now() + 60_000;
    await p.notifications.schedule('rest-timer', at, { title: 'Отдых', body: 'пора', tag: 'rest-timer' });
    const sent = (h.schedule.mock.calls[0] as unknown as [{ notifications: Array<{ id: number; schedule: { at: Date; allowWhileIdle: boolean } }> }])[0].notifications[0];
    expect(Number.isInteger(sent.id) && sent.id > 0).toBe(true);
    expect(sent.schedule.at.getTime()).toBe(at);
    expect(sent.schedule.allowWhileIdle).toBe(true);
    await p.notifications.cancel('rest-timer');
    expect(h.cancel).toHaveBeenCalledWith({ notifications: [{ id: sent.id }] });
  });

  it('ошибка плагина уведомлений не ломает приложение', async () => {
    h.schedule.mockRejectedValueOnce(new Error('denied'));
    const p = await createNativePlatform('x');
    await expect(p.notifications.show({ title: 'a', body: 'b', tag: 't' })).resolves.toBeUndefined();
  });

  it('экран: keepAwake/allowSleep; отказ плагина — no-op', async () => {
    const p = await createNativePlatform('x');
    const off = await p.wakeLock.acquire();
    expect(h.keepAwake).toHaveBeenCalled();
    off();
    expect(h.allowSleep).toHaveBeenCalled();
    h.keepAwake.mockRejectedValueOnce(new Error('x'));
    await expect((async () => (await p.wakeLock.acquire())())()).resolves.toBeUndefined();
  });

  it('экспорт: текст и Blob пишутся во временный файл и уходят в «Поделиться», имя очищено', async () => {
    const p = await createNativePlatform('x');
    await p.files.save('отчёт 2026/10/29: итоги.csv', 'text/csv', 'a,b\n1,2');
    expect(h.writeFile).toHaveBeenLastCalledWith({ path: 'отчёт 2026_10_29_ итоги.csv', data: 'a,b\n1,2', directory: 'CACHE', encoding: 'utf8' });
    expect(h.share).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'file:///cache/отчёт 2026_10_29_ итоги.csv' }));

    await p.files.save('t.gpx', 'application/gpx+xml', new Blob(['<gpx/>']));
    expect(h.writeFile).toHaveBeenLastCalledWith({ path: 't.gpx', data: btoa('<gpx/>'), directory: 'CACHE' });
  });

  it('каналы Android создаются при старте: громкий для таймера, обычный для напоминаний', async () => {
    await createNativePlatform('x');
    const ids = h.createChannel.mock.calls.map((c) => (c as unknown as [{ id: string; importance: number }])[0]);
    expect(ids.map((c) => c.id)).toEqual(['rest-timer', 'reminders']);
    expect(ids[0].importance).toBe(5);
  });

  it('уведомление с кнопкой: тип действий регистрируется один раз, канал и метка уходят в плагин', async () => {
    const p = await createNativePlatform('x');
    expect(p.notifications.background).toBe(true);
    const opts = { title: 'Отдых закончился', body: 'пора', tag: 'rest-timer', channel: 'rest-timer' as const, actions: [{ id: 'add15', title: '+15 с' }] };
    await p.notifications.schedule('rest-timer', Date.now() + 1000, opts);
    await p.notifications.schedule('rest-timer', Date.now() + 2000, opts);
    expect(h.registerActionTypes).toHaveBeenCalledTimes(1);
    const sent = (h.schedule.mock.calls[1] as unknown as [{ notifications: Array<Record<string, unknown>> }])[0].notifications[0];
    expect(sent).toMatchObject({ channelId: 'rest-timer', actionTypeId: 'add15', extra: { tag: 'rest-timer' } });
  });

  it('нажатие кнопки приходит подписчику с идентификатором действия и меткой; отписка снимает слушатель', async () => {
    const p = await createNativePlatform('x');
    const got: Array<[string, string]> = [];
    const off = p.notifications.onAction((a, t) => got.push([a, t]));
    await flush();
    h.actionCb!({ actionId: 'add15', notification: { extra: { tag: 'rest-timer' } } });
    h.actionCb!({ actionId: 'tap', notification: {} });
    expect(got).toEqual([['add15', 'rest-timer'], ['tap', '']]);
    off(); await flush();
    expect(h.remove).toHaveBeenCalled();
  });

  it('cancel отменяет запланированное и убирает уже показанное', async () => {
    const p = await createNativePlatform('x');
    await p.notifications.cancel('rest-timer');
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.removeDelivered).toHaveBeenCalledTimes(1);
  });

  it('точные будильники: состояние из системы, запрос открывает настройки и перечитывает результат', async () => {
    const p = await createNativePlatform('x');
    expect(await p.notifications.exactAlarm()).toBe('granted');
    h.exact = 'denied';
    expect(await p.notifications.exactAlarm()).toBe('denied');
    expect(await p.notifications.requestExactAlarm()).toBe('denied');
    expect(h.changeExact).toHaveBeenCalledTimes(1);
  });

  const BG = { background: { title: 'Идёт запись маршрута', message: 'Нажми, чтобы вернуться.' } };

  it('фоновая запись: сервис с уведомлением, точки приводятся к общему виду, отказ в доступе — «denied»', async () => {
    const p = await createNativePlatform('x');
    expect(p.geo.background).toBe(true);
    const fixes: unknown[] = [], errors: string[] = [];
    p.geo.watch((f) => fixes.push(f), (k) => errors.push(k), BG);
    await flush();
    expect(h.addWatcher).toHaveBeenCalledWith(
      { backgroundTitle: 'Идёт запись маршрута', backgroundMessage: 'Нажми, чтобы вернуться.', requestPermissions: true, stale: false, distanceFilter: 0 },
      expect.any(Function)
    );
    h.bgCb!({ latitude: 55, longitude: 37, accuracy: 4, altitude: 120, time: 9000 });
    h.bgCb!({ latitude: 55.1, longitude: 37.1, accuracy: 6, altitude: null, time: null });
    h.bgCb!(undefined, { code: 'NOT_AUTHORIZED' });
    h.bgCb!(undefined, { code: 'OTHER' });
    expect(fixes[0]).toEqual({ t: 9000, lat: 55, lon: 37, acc: 4, ele: 120 });
    expect(fixes[1]).toMatchObject({ lat: 55.1, ele: null });
    expect(errors).toEqual(['denied', 'unavailable']);
    expect(h.geoCb).toBeNull(); // обычное наблюдение при этом не запускалось
  });

  it('фоновая запись: сначала спрашивается разрешение на уведомления (Android 13+), и только потом стартует сервис', async () => {
    const p = await createNativePlatform('x');
    p.geo.watch(() => {}, () => {}, BG);
    await flush();
    expect(h.order).toEqual(['notif-permission', 'add-watcher']);

    h.order = [];
    h.notifPerm = 'granted';
    const p2 = await createNativePlatform('x'); // разрешение уже выдано: повторно не спрашиваем
    p2.geo.watch(() => {}, () => {}, BG);
    await flush();
    expect(h.order).toEqual(['add-watcher']);
  });

  it('фоновая запись: stop снимает наблюдателя, в том числе если вызван до готовности', async () => {
    const p = await createNativePlatform('x');
    const w = p.geo.watch(() => {}, () => {}, BG);
    await flush();
    w.stop();
    expect(h.removeWatcher).toHaveBeenCalledWith({ id: 'bg1' });

    h.removeWatcher.mockClear();
    const early = p.geo.watch(() => {}, () => {}, BG);
    early.stop(); // остановили раньше, чем плагин вернул идентификатор
    await flush();
    expect(h.removeWatcher).toHaveBeenCalledWith({ id: 'bg1' });
    expect(h.removeWatcher).toHaveBeenCalledTimes(1);
  });

  it('без background остаётся обычное наблюдение без постоянного уведомления', async () => {
    const p = await createNativePlatform('x');
    p.geo.watch(() => {}, () => {});
    await flush();
    expect(h.addWatcher).not.toHaveBeenCalled();
    expect(h.geoCb).not.toBeNull();
  });

  describe('пульсометр (Bluetooth LE)', () => {
    const HR = '0000180d-0000-1000-8000-00805f9b34fb', MEAS = '00002a37-0000-1000-8000-00805f9b34fb';
    beforeEach(() => {
      h.ble.isEnabled.mockResolvedValue(true);
      h.ble.requestDevice.mockReset(); h.ble.connect.mockReset(); h.ble.startNotifications.mockReset();
      h.ble.stopNotifications.mockClear(); h.ble.disconnect.mockClear(); h.ble.initialize.mockClear(); h.ble.requestEnable.mockClear();
    });

    it('выбор датчика: фильтр по сервису Heart Rate, Bluetooth без геопозиции; пустое имя заменяется', async () => {
      const p = await createNativePlatform('x');
      h.ble.requestDevice.mockResolvedValue({ deviceId: 'AA:BB', name: 'Polar H10' });
      expect(await p.heartRate.pick()).toEqual({ id: 'AA:BB', name: 'Polar H10' });
      expect(h.ble.initialize).toHaveBeenCalledWith({ androidNeverForLocation: true });
      expect(h.ble.requestDevice).toHaveBeenCalledWith({ services: [HR] });
      h.ble.requestDevice.mockResolvedValue({ deviceId: 'CC:DD' });
      expect(await p.heartRate.pick()).toEqual({ id: 'CC:DD', name: 'Пульсометр' });
    });

    it('выключенный Bluetooth предлагается включить; отказ в окне выбора — null, остальное — понятная ошибка', async () => {
      const p = await createNativePlatform('x');
      h.ble.isEnabled.mockResolvedValue(false);
      h.ble.requestDevice.mockResolvedValue({ deviceId: 'a', name: 'b' });
      await p.heartRate.pick();
      expect(h.ble.requestEnable).toHaveBeenCalled();
      h.ble.requestDevice.mockRejectedValue(new Error('User cancelled requestDevice'));
      expect(await p.heartRate.pick()).toBeNull();
      h.ble.requestDevice.mockRejectedValue(new Error('Missing permission BLUETOOTH_SCAN denied'));
      await expect(p.heartRate.pick()).rejects.toThrow(/разреши «Устройства поблизости»/i);
      h.ble.requestDevice.mockRejectedValue(new Error('boom'));
      await expect(p.heartRate.pick()).rejects.toThrow(/Не удалось найти пульсометр: boom/);
    });

    it('подключение: отсчёты разбираются, потеря связи сообщается, close отписывается и отключает', async () => {
      const p = await createNativePlatform('x');
      let onDisc: (id: string) => void = () => {}; let onData: (v: DataView) => void = () => {};
      h.ble.connect.mockImplementation(async (_id: string, cb: (id: string) => void) => { onDisc = cb; });
      h.ble.startNotifications.mockImplementation(async (_id: string, _s: string, _c: string, cb: (v: DataView) => void) => { onData = cb; });
      const samples: number[] = []; const lost = vi.fn();
      const link = await p.heartRate.connect('AA:BB', { onSample: (s) => samples.push(s.bpm), onLost: lost });
      expect(h.ble.connect).toHaveBeenCalledWith('AA:BB', expect.any(Function), { timeout: 10_000 });
      expect(h.ble.startNotifications).toHaveBeenCalledWith('AA:BB', HR, MEAS, expect.any(Function));
      onData(new DataView(new Uint8Array([0x00, 142]).buffer));
      onData(new DataView(new Uint8Array([0x00]).buffer)); // обрезанный пакет пропускается
      expect(samples).toEqual([142]);
      onDisc('AA:BB');
      expect(lost).toHaveBeenCalledTimes(1);
      await link.close();
      expect(h.ble.stopNotifications).toHaveBeenCalledWith('AA:BB', HR, MEAS);
      expect(h.ble.disconnect).toHaveBeenCalledWith('AA:BB');
      onDisc('AA:BB'); // после close потеря связи уже не сообщается
      expect(lost).toHaveBeenCalledTimes(1);
    });

    it('не удалось подписаться на измерения: соединение закрывается, ошибка уходит вызывающему', async () => {
      const p = await createNativePlatform('x');
      h.ble.connect.mockResolvedValue(undefined);
      h.ble.startNotifications.mockRejectedValue(new Error('no service'));
      await expect(p.heartRate.connect('AA', { onSample: () => {}, onLost: () => {} })).rejects.toThrow('no service');
      expect(h.ble.disconnect).toHaveBeenCalledWith('AA');
    });
  });

  it('защищённое хранилище: значения идут в Keystore, сбой чтения даёт null', async () => {
    const p = await createNativePlatform('x');
    expect(p.secureStorage.hardwareBacked).toBe(true);
    await p.secureStorage.set('sync.token', 'T');
    expect(h.ss.setItem).toHaveBeenCalledWith('sync.token', 'T');
    h.ss.getItem.mockResolvedValueOnce('T');
    expect(await p.secureStorage.get('sync.token')).toBe('T');
    h.ss.getItem.mockRejectedValueOnce(new Error('keystore'));
    expect(await p.secureStorage.get('sync.token')).toBeNull();
    await p.secureStorage.remove('sync.token');
    expect(h.ss.remove).toHaveBeenCalledWith('sync.token');
  });

  it('хранилище копий: закрытая область приложения, подпапка backups', async () => {
    const p = await createNativePlatform('x');
    expect(p.backups.available).toBe(true);
    await p.backups.write('a.rfb', 'текст');
    expect(h.fs.mkdir).toHaveBeenCalledWith({ path: 'backups', directory: 'DATA', recursive: true });
    expect(h.writeFile).toHaveBeenLastCalledWith({ path: 'backups/a.rfb', data: 'текст', directory: 'DATA', encoding: 'utf8' });
    h.fs.readdir.mockResolvedValue({ files: [{ name: 'a.rfb', type: 'file', size: 5, mtime: 7 }, { name: 'sub', type: 'directory', size: 0 }] });
    expect(await p.backups.list()).toEqual([{ name: 'a.rfb', size: 5, mtime: 7 }]);
    h.fs.readdir.mockRejectedValue(new Error('нет папки'));
    expect(await p.backups.list()).toEqual([]);
    h.fs.readFile.mockResolvedValue({ data: 'содержимое' });
    expect(await p.backups.read('a.rfb')).toBe('содержимое');
    await p.backups.remove('a.rfb');
    expect(h.fs.deleteFile).toHaveBeenCalledWith({ path: 'backups/a.rfb', directory: 'DATA' });
  });

  describe('сканер QR', () => {
    it('возвращает текст первого кода; формат ограничен QR', async () => {
      const p = await createNativePlatform('x');
      expect(p.scanner.available).toBe(true);
      h.qr.requestPermissions.mockResolvedValue({ camera: 'granted' });
      h.qr.scan.mockResolvedValue({ barcodes: [{ rawValue: 'https://pc.ts.net/#/pair/ABCD-1234' }, { rawValue: 'второй' }] });
      expect(await p.scanner.scanQr()).toBe('https://pc.ts.net/#/pair/ABCD-1234');
      expect(h.qr.scan).toHaveBeenCalledWith({ formats: ['QR_CODE'] });
    });

    it('отказ в камере — понятная ошибка и сканер не открывается; закрытие сканера — null; сбой — подсказка про ручной ввод', async () => {
      const p = await createNativePlatform('x');
      h.qr.scan.mockClear();
      h.qr.requestPermissions.mockResolvedValue({ camera: 'denied' });
      await expect(p.scanner.scanQr()).rejects.toThrow(/Нет доступа к камере/);
      expect(h.qr.scan).not.toHaveBeenCalled();

      h.qr.requestPermissions.mockResolvedValue({ camera: 'granted' });
      h.qr.scan.mockRejectedValueOnce(new Error('scan canceled.'));
      expect(await p.scanner.scanQr()).toBeNull();
      h.qr.scan.mockResolvedValueOnce({ barcodes: [] });
      expect(await p.scanner.scanQr()).toBeNull();
      h.qr.scan.mockRejectedValueOnce(new Error('camera in use'));
      await expect(p.scanner.scanQr()).rejects.toThrow(/вручную/);
    });
  });
});
