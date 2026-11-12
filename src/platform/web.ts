import type {
  BackupStoreApi, ScannerApi, FilesApi, GeoApi, GeoErrorKind, HapticsApi, HeartRateApi, LifecycleApi, NotificationsApi, NotifyOptions, NotifyPermission,
  Platform, SecureStorageApi, SpeechApi, WakeLockApi, AudioStoreApi
} from './types';
import { createHtmlAudioPlayer } from './audio';

// Реализация для браузера и PWA: ровно те вызовы, которые раньше были разбросаны по приложению.

/** Web Speech: onend бывает не приходит (особенно в фоне), поэтому ожидание ограничено по длине текста. */
export const webSpeech: SpeechApi = {
  background: false,
  get available() { return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'; },
  speak(text, lang = 'ru-RU') {
    if (!this.available) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const end = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(end, 3000 + text.length * 120);
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        u.onend = end; u.onerror = end;
        window.speechSynthesis.speak(u);
      } catch { end(); }
    });
  },
  async stop() { try { window.speechSynthesis?.cancel(); } catch { /* необязательно */ } }
};

/** Ничего не умеет: для платформ без озвучки и для тестов. */
export const stubSpeech: SpeechApi = { available: false, background: false, speak: async () => {}, stop: async () => {} };

export const webGeo: GeoApi = {
  background: false,
  unsupportedReason() {
    if (!('geolocation' in navigator)) return 'Этот браузер не умеет определять местоположение.';
    if (!window.isSecureContext) return 'GPS работает только по защищённому адресу (https://). Открой приложение через Tailscale или на самом ПК. Результат можно ввести вручную.';
    return null;
  },
  watch(onFix, onError) {
    const id = navigator.geolocation.watchPosition(
      (pos) => onFix({ t: pos.timestamp, lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, ele: pos.coords.altitude }),
      (err) => onError((err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable') satisfies GeoErrorKind),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
    return { stop: () => navigator.geolocation.clearWatch(id) };
  }
};

// Service worker может не быть (нативная сборка, обычная вкладка без установки): ждать `ready` вечно нельзя.
async function swRegistration(timeoutMs = 1500): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs))
  ]);
}

const scheduled = new Map<string, number>();

export const webNotifications: NotificationsApi = {
  permission(): NotifyPermission {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  },
  async request() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.requestPermission();
  },
  async show({ title, body, tag, icon }: NotifyOptions) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const reg = await swRegistration();
      if (reg) await reg.showNotification(title, { body, tag, icon });
      else new Notification(title, { body, tag, icon });
    } catch { /* уведомление необязательно */ }
  },
  // В браузере запланированное уведомление живёт, пока жива страница: ровно как прежний setTimeout.
  async schedule(id, atMs, opts) {
    await this.cancel(id);
    scheduled.set(id, window.setTimeout(() => { scheduled.delete(id); void this.show(opts); }, Math.max(0, atMs - Date.now())));
  },
  async cancel(id) {
    const t = scheduled.get(id);
    if (t !== undefined) { clearTimeout(t); scheduled.delete(id); }
  },
  background: false,
  onAction() { return () => {}; },
  async exactAlarm() { return 'unsupported'; },
  async requestExactAlarm() { return 'unsupported'; }
};

export const webWakeLock: WakeLockApi = {
  async acquire() {
    if (!('wakeLock' in navigator)) return () => {};
    try {
      const l = await navigator.wakeLock.request('screen');
      return () => { void l.release(); };
    } catch { return () => {}; } // система может отказать (экономия заряда) — это не критично
  }
};

export const webHaptics: HapticsApi = {
  vibrate(pattern) { if ('vibrate' in navigator) navigator.vibrate(pattern); }
};

export const webLifecycle: LifecycleApi = {
  onResume(cb) {
    const h = () => { if (document.visibilityState === 'visible') cb(); };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  },
  onPause(cb) {
    const h = () => { if (document.visibilityState === 'hidden') cb(); };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  },
  onBackButton() { return () => {}; },
  onOpenUrl() { return () => {}; }
};

// В браузере защищённого хранилища нет: остаётся IndexedDB/localStorage на стороне вызывающего.
// Этот вариант нужен только как контракт; пользоваться им стоит через `platform.info.native`.
export const webSecureStorage: SecureStorageApi = {
  hardwareBacked: false,
  async get(key) { return localStorage.getItem('secure:' + key); },
  async set(key, value) { localStorage.setItem('secure:' + key, value); },
  async remove(key) { localStorage.removeItem('secure:' + key); }
};

export const webFiles: FilesApi = {
  async save(name, mime, data) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

export const webHeartRate: HeartRateApi = {
  unsupportedReason: () => 'Пульсометр по Bluetooth подключается в приложении для Android. В браузере пульс вводится вручную.',
  async pick() { return null; },
  async connect() { throw new Error('Пульсометр недоступен в браузере'); }
};

// В браузере своей файловой области нет: копии делаются вручную («Экспорт» в настройках).
export const webBackups: BackupStoreApi = {
  available: false,
  async write() { throw new Error('Автокопии недоступны в браузере'); },
  async list() { return []; },
  async read() { throw new Error('Автокопии недоступны в браузере'); },
  async remove() { /* нечего удалять */ }
};

// В браузере QR с экрана ПК открывается обычной камерой телефона: ссылка сама ведёт на страницу сопряжения.
export const webScanner: ScannerApi = {
  available: false,
  async scanQr() { return null; }
};

// Готовые фразы Fish в браузере лежат в Cache Storage: он переживает перезапуск страницы и не мешает кэшу сервис-воркера.
const TTS_CACHE = 'repforge-tts-v1';
const ttsReq = (name: string) => new Request(`https://tts.invalid/__tts/${encodeURIComponent(name)}`); // ключ, не настоящий адрес: запросов по нему нет

export function createWebAudioStore(): AudioStoreApi {
  const ok = () => typeof caches !== 'undefined';
  return {
    get available() { return ok(); },
    async put(name, data) {
      if (!ok()) throw new Error('Хранилище недоступно');
      const c = await caches.open(TTS_CACHE);
      await c.put(ttsReq(name), new Response(data, { headers: { 'content-type': data.type || 'audio/mpeg', 'content-length': String(data.size) } }));
    },
    async has(name) { return ok() && !!(await (await caches.open(TTS_CACHE)).match(ttsReq(name))); },
    async open(name) {
      if (!ok()) return null;
      const res = await (await caches.open(TTS_CACHE)).match(ttsReq(name));
      if (!res) return null;
      const url = URL.createObjectURL(await res.blob());
      return { url, release: () => URL.revokeObjectURL(url) };
    },
    async remove(name) { if (ok()) await (await caches.open(TTS_CACHE)).delete(ttsReq(name)); },
    async list() {
      if (!ok()) return [];
      const c = await caches.open(TTS_CACHE);
      const out = [];
      for (const req of await c.keys()) {
        const res = await c.match(req);
        out.push({ name: decodeURIComponent(new URL(req.url).pathname.replace(/^\/__tts\//, '')), bytes: Number(res?.headers.get('content-length') ?? 0) });
      }
      return out;
    }
  };
}

export const webAudioStore: AudioStoreApi = createWebAudioStore();
export const webAudioPlayer = createHtmlAudioPlayer();

export function createWebPlatform(version: string): Platform {
  return {
    info: { native: false, os: 'web', version },
    geo: webGeo, notifications: webNotifications, wakeLock: webWakeLock, haptics: webHaptics,
    lifecycle: webLifecycle, secureStorage: webSecureStorage, files: webFiles, heartRate: webHeartRate, backups: webBackups, scanner: webScanner, speech: webSpeech,
    audioStore: webAudioStore, audioPlayer: webAudioPlayer
  };
}
