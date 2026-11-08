import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Share } from '@capacitor/share';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import type { ScannerApi, BackupStoreApi, ExactAlarmState, FilesApi, HeartRateApi, SecureStorageApi, GeoApi, GeoWatchOptions, LifecycleApi, NotificationsApi, NotifyOptions, NotifyPermission, Platform, SpeechApi, WakeLockApi } from './types';
import { HR_MEASUREMENT_UUID, HR_SERVICE_UUID, parseHeartRate } from '../cardio/hrParse';
import { webHaptics } from './web';

// Нативная оболочка (Capacitor). Этап 1: то, без чего браузерные API в WebView не работают или ненадёжны.
// Фоновый GPS, точные будильники, BLE и Keychain/Keystore добавляются следующими этапами плана.

const listen = (event: 'resume' | 'pause' | 'backButton' | 'appUrlOpen', cb: (e: never) => void) => {
  const h = App.addListener(event as 'resume', cb as () => void);
  return () => { void h.then((x) => x.remove()); };
};

// Фоновая запись: плагин держит foreground-сервис с постоянным уведомлением, поэтому система не усыпляет процесс
// при погашенном экране. Пока приложение живо, точки доходят в JS и дописываются в трек.
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

const geo: GeoApi = {
  background: true,
  unsupportedReason: () => null,
  watch(onFix, onError, opts?: GeoWatchOptions) {
    let stop: (() => void) | null = null;
    let stopped = false;
    const finish = (fn: () => void) => { if (stopped) fn(); else stop = fn; };

    void (async () => {
      try {
        if (opts?.background) {
          // Android 13+: без разрешения на уведомления постоянное уведомление сервиса не покажется (запись всё равно идёт)
          if (permCache === 'default') await notifications.request();
          if (stopped) return;
          const id = await BackgroundGeolocation.addWatcher(
            { backgroundTitle: opts.background.title, backgroundMessage: opts.background.message, requestPermissions: true, stale: false, distanceFilter: 0 },
            (loc, err) => {
              if (err || !loc) { onError(err?.code === 'NOT_AUTHORIZED' ? 'denied' : 'unavailable'); return; }
              onFix({ t: loc.time ?? Date.now(), lat: loc.latitude, lon: loc.longitude, acc: loc.accuracy, ele: loc.altitude ?? null });
            }
          );
          finish(() => { void BackgroundGeolocation.removeWatcher({ id }); });
          return;
        }
        const perm = await Geolocation.requestPermissions({ permissions: ['location'] });
        if (perm.location === 'denied') { onError('denied'); return; }
        const watchId = await Geolocation.watchPosition(
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
          (pos, err) => {
            if (err || !pos) { onError('unavailable'); return; }
            onFix({ t: pos.timestamp, lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, ele: pos.coords.altitude ?? null });
          }
        );
        finish(() => { void Geolocation.clearWatch({ id: watchId }); });
      } catch { onError('unavailable'); }
    })();

    return { stop: () => { stopped = true; if (stop) { stop(); stop = null; } } };
  }
};

const toPerm = (v: string): NotifyPermission => (v === 'granted' ? 'granted' : v === 'denied' ? 'denied' : 'default');
let permCache: NotifyPermission = 'default';
// Идентификатор нативного уведомления — число; из строкового id делаем стабильный хэш.
const numId = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) || 1; };

// Каналы Android создаются один раз; настройки звука и вибрации потом меняет только пользователь в системе.
const CHANNELS = [
  { id: 'rest-timer', name: 'Таймер отдыха', description: 'Сигнал об окончании отдыха между подходами', importance: 5 as const, vibration: true },
  { id: 'reminders', name: 'Напоминания о тренировках', description: 'Тренировка по плану', importance: 4 as const, vibration: true }
];

// Кнопки уведомлений регистрируются как «типы действий»: тип определяется набором кнопок.
const actionTypes = new Map<string, Array<{ id: string; title: string }>>();
const actionTypeOf = async (actions: NotifyOptions['actions']): Promise<string | undefined> => {
  if (!actions?.length) return undefined;
  const id = actions.map((a) => a.id).join('|');
  if (!actionTypes.has(id)) {
    actionTypes.set(id, actions.map(({ id: aid, title }) => ({ id: aid, title })));
    await LocalNotifications.registerActionTypes({ types: [...actionTypes].map(([tid, list]) => ({ id: tid, actions: list })) });
  }
  return id;
};

const schema = async (id: string, o: NotifyOptions) => ({
  id: numId(id), title: o.title, body: o.body, channelId: o.channel ?? 'reminders',
  actionTypeId: await actionTypeOf(o.actions), extra: { tag: o.tag }
});

const exactState = (v: string): ExactAlarmState => (v === 'granted' ? 'granted' : 'denied');

const notifications: NotificationsApi = {
  background: true,
  permission: () => permCache,
  async request() {
    const r = await LocalNotifications.requestPermissions();
    return (permCache = toPerm(r.display));
  },
  async show(o: NotifyOptions) {
    try { await LocalNotifications.schedule({ notifications: [await schema(o.tag, o)] }); } catch { /* необязательно */ }
  },
  // Точный будильник, если пользователь его разрешил; иначе система сама применит неточный (может опоздать на минуты в Doze).
  async schedule(id, atMs, o) {
    try {
      await LocalNotifications.schedule({ notifications: [{ ...(await schema(id, o)), schedule: { at: new Date(atMs), allowWhileIdle: true } }] });
    } catch { /* необязательно */ }
  },
  async cancel(id) {
    const notifications = [{ id: numId(id) }];
    try { await LocalNotifications.cancel({ notifications }); } catch { /* необязательно */ }
    try { await LocalNotifications.removeDeliveredNotifications({ notifications: [{ id: numId(id), title: '', body: '' }] }); } catch { /* необязательно */ }
  },
  onAction(cb) {
    const h = LocalNotifications.addListener('localNotificationActionPerformed', (ev) => {
      const tag = (ev.notification.extra as { tag?: string } | undefined)?.tag ?? '';
      cb(ev.actionId, tag);
    });
    return () => { void h.then((x) => x.remove()); };
  },
  async exactAlarm() {
    try { return exactState((await LocalNotifications.checkExactNotificationSetting()).exact_alarm); } catch { return 'unsupported'; }
  },
  async requestExactAlarm() {
    try { await LocalNotifications.changeExactNotificationSetting(); return exactState((await LocalNotifications.checkExactNotificationSetting()).exact_alarm); } catch { return 'unsupported'; }
  }
};

const wakeLock: WakeLockApi = {
  async acquire() {
    try { await KeepAwake.keepAwake(); } catch { return () => {}; }
    return () => { void KeepAwake.allowSleep().catch(() => {}); };
  }
};

const lifecycle: LifecycleApi = {
  onResume: (cb) => listen('resume', cb),
  onPause: (cb) => listen('pause', cb),
  onBackButton: (cb) => listen('backButton', ((e: { canGoBack: boolean }) => cb(e.canGoBack)) as (e: never) => void),
  onOpenUrl: (cb) => listen('appUrlOpen', ((e: { url: string }) => cb(e.url)) as (e: never) => void)
};

// Экспорт: во WebView скачивание через <a download> не работает, поэтому пишем во временный файл и открываем «Поделиться».
const files: FilesApi = {
  async save(name, mime, data) {
    const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, '_');
    let written;
    if (typeof data === 'string') {
      written = await Filesystem.writeFile({ path: safe, data, directory: Directory.Cache, encoding: Encoding.UTF8 });
    } else {
      const bytes = new Uint8Array(await data.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const b64 = btoa(bin);
      written = await Filesystem.writeFile({ path: safe, data: b64, directory: Directory.Cache });
    }
    await Share.share({ title: safe, url: written.uri, dialogTitle: 'Сохранить файл' });
    void mime;
  }
};

// Пульсометр по Bluetooth LE (профиль Heart Rate, 0x180D). Подключение, потерю связи и повторные попытки
// ведёт `cardio/hrSession.ts`; здесь только вызовы плагина.
let bleReady = false;
const ensureBle = async () => {
  if (bleReady) return;
  await BleClient.initialize({ androidNeverForLocation: true });
  bleReady = true;
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const heartRate: HeartRateApi = {
  unsupportedReason: () => null,
  async pick() {
    try {
      await ensureBle();
      if (!(await BleClient.isEnabled())) await BleClient.requestEnable();
      const d = await BleClient.requestDevice({ services: [HR_SERVICE_UUID] });
      return { id: d.deviceId, name: d.name || 'Пульсометр' };
    } catch (e) {
      if (/cancel|dismiss/i.test(errText(e))) return null; // закрыли окно выбора
      throw new Error(/permission|denied/i.test(errText(e))
        ? 'Нет разрешения на Bluetooth. Разреши «Устройства поблизости» для приложения в настройках телефона.'
        : `Не удалось найти пульсометр: ${errText(e)}`);
    }
  },
  async connect(id, h) {
    await ensureBle();
    let closed = false;
    await BleClient.connect(id, () => { if (!closed) h.onLost(); }, { timeout: 10_000 });
    try {
      await BleClient.startNotifications(id, HR_SERVICE_UUID, HR_MEASUREMENT_UUID, (view) => {
        const sample = parseHeartRate(view);
        if (sample) h.onSample(sample);
      });
    } catch (e) {
      closed = true;
      try { await BleClient.disconnect(id); } catch { /* уже отключён */ }
      throw e;
    }
    return {
      async close() {
        closed = true;
        try { await BleClient.stopNotifications(id, HR_SERVICE_UUID, HR_MEASUREMENT_UUID); } catch { /* уже отключён */ }
        try { await BleClient.disconnect(id); } catch { /* уже отключён */ }
      }
    };
  }
};

// Keystore (Android) / Keychain (iOS). Ключ шифрования не покидает защищённое хранилище системы.
const secureStorage: SecureStorageApi = {
  hardwareBacked: true,
  async get(key) { try { return await SecureStorage.getItem(key); } catch { return null; } },
  async set(key, value) { await SecureStorage.setItem(key, value); },
  async remove(key) { try { await SecureStorage.remove(key); } catch { /* нечего удалять */ } }
};

// Автокопии лежат в закрытой области приложения. Общая папка «Документы» на Android 11+ без особого доступа
// ко всем файлам недоступна для записи, поэтому для хранения вне телефона есть «Экспорт» и синхронизация с сервером.
const BACKUP_DIR = 'backups';
const backups: BackupStoreApi = {
  available: true,
  async write(name, text) {
    try { await Filesystem.mkdir({ path: BACKUP_DIR, directory: Directory.Data, recursive: true }); } catch { /* папка уже есть */ }
    await Filesystem.writeFile({ path: `${BACKUP_DIR}/${name}`, data: text, directory: Directory.Data, encoding: Encoding.UTF8 });
  },
  async list() {
    try {
      const r = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Data });
      return r.files.filter((f) => f.type === 'file').map((f) => ({ name: f.name, size: f.size, mtime: f.mtime ?? 0 }));
    } catch { return []; }
  },
  async read(name) {
    const r = await Filesystem.readFile({ path: `${BACKUP_DIR}/${name}`, directory: Directory.Data, encoding: Encoding.UTF8 });
    return typeof r.data === 'string' ? r.data : await r.data.text();
  },
  async remove(name) {
    try { await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${name}`, directory: Directory.Data }); } catch { /* уже удалён */ }
  }
};

// Системный TTS: работает при погашенном экране, пока жива запись (foreground-сервис геолокации держит процесс).
const speech: SpeechApi = {
  available: true,
  background: true,
  async speak(text, lang = 'ru-RU') {
    try { await TextToSpeech.speak({ text, lang, rate: 1.0, pitch: 1.0, volume: 1.0, queueStrategy: 1 }); } catch { /* нет движка или языка: озвучка необязательна */ }
  },
  async stop() { try { await TextToSpeech.stop(); } catch { /* необязательно */ } }
};

const scanner: ScannerApi = {
  available: true,
  async scanQr() {
    const perm = await BarcodeScanner.requestPermissions();
    if (perm.camera !== 'granted' && perm.camera !== 'limited') throw new Error('Нет доступа к камере. Разреши камеру для приложения в настройках телефона или введи адрес и код вручную.');
    try {
      const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
      return barcodes[0]?.rawValue ?? null;
    } catch (e) {
      if (/cancel|dismiss|closed/i.test(e instanceof Error ? e.message : String(e))) return null;
      throw new Error('Не удалось открыть сканер QR. Введи адрес и код вручную.');
    }
  }
};

export async function createNativePlatform(version: string): Promise<Platform> {
  const os = Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';
  try { permCache = toPerm((await LocalNotifications.checkPermissions()).display); } catch { /* оставляем 'default' */ }
  for (const c of CHANNELS) { try { await LocalNotifications.createChannel(c); } catch { /* канал уже есть или это не Android */ } }

  // Системная «Назад»: по истории экранов, а на корне — выход. Без своего обработчика Capacitor её не отдаёт.
  lifecycle.onBackButton((canGoBack) => { if (canGoBack) history.back(); else void App.exitApp(); });

  return {
    info: { native: true, os, version },
    geo, notifications, wakeLock, lifecycle, files,
    haptics: webHaptics, // navigator.vibrate работает в WebView при разрешении VIBRATE
    secureStorage, heartRate, backups, scanner, speech
  };
}
