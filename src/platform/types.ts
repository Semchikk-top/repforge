// Слой платформы: всё, что в браузере и в нативной оболочке (Capacitor) делается по-разному.
// UI и состояние ходят только сюда и не трогают navigator.* / Notification напрямую.

export interface GeoFix { t: number; lat: number; lon: number; acc: number; ele: number | null }
export type GeoErrorKind = 'denied' | 'unavailable';
export interface GeoWatchHandle { stop(): void }

export interface GeoWatchOptions {
  /** Продолжать получать точки при погашенном экране: в нативной оболочке показывается постоянное уведомление. */
  background?: { title: string; message: string };
}

export interface GeoApi {
  /** Причина, по которой GPS недоступен, или null, если всё в порядке. */
  unsupportedReason(): string | null;
  /** true — с `background` точки приходят и при погашенном экране; false (браузер) — только пока приложение на экране. */
  readonly background: boolean;
  watch(onFix: (fix: GeoFix) => void, onError: (kind: GeoErrorKind) => void, opts?: GeoWatchOptions): GeoWatchHandle;
}

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';
export interface NotifyAction { id: string; title: string }
export interface NotifyOptions {
  title: string; body: string; tag: string; icon?: string;
  /** Канал Android: у таймера отдыха громкий и с вибрацией, у напоминаний обычный. В браузере игнорируется. */
  channel?: 'rest-timer' | 'reminders';
  /** Кнопки под уведомлением (в нативной оболочке). Нажатие приходит в `onAction`. */
  actions?: NotifyAction[];
}
export type ExactAlarmState = 'granted' | 'denied' | 'unsupported';

export interface NotificationsApi {
  permission(): NotifyPermission;
  request(): Promise<NotifyPermission>;
  /** Показать уведомление сейчас. Ошибки глотает: уведомление всегда необязательно. */
  show(opts: NotifyOptions): Promise<void>;
  /** Запланировать на момент `atMs` (Date.now()-время). Повторный вызов с тем же id заменяет прежнее. */
  schedule(id: string, atMs: number, opts: NotifyOptions): Promise<void>;
  /** Отменить запланированное и убрать уже показанное уведомление с таким id. */
  cancel(id: string): Promise<void>;
  /**
   * true — запланированное уведомление сработает, даже когда приложение свёрнуто или заморожено системой.
   * false (браузер) — планирование живёт, пока жива страница, поэтому для фона на него полагаться нельзя.
   */
  readonly background: boolean;
  /** Нажатие кнопки под уведомлением. Возвращает отписку. */
  onAction(cb: (actionId: string, tag: string) => void): () => void;
  /** Точные будильники (Android 12+). Без них системе позволено задерживать уведомление на минуты. */
  exactAlarm(): Promise<ExactAlarmState>;
  requestExactAlarm(): Promise<ExactAlarmState>;
}

export interface WakeLockApi {
  /** Возвращает функцию отпускания. Если система отказала — просто no-op. */
  acquire(): Promise<() => void>;
}

export interface HapticsApi { vibrate(pattern: number | number[]): void }

export interface LifecycleApi {
  /** Приложение стало видимым / ушло в фон. Возвращает отписку. */
  onResume(cb: () => void): () => void;
  onPause(cb: () => void): () => void;
  /** Системная кнопка «Назад» (Android). В браузере не вызывается. Возвращает отписку. */
  onBackButton(cb: (canGoBack: boolean) => void): () => void;
  /** Открытие приложения по ссылке (deep link). В браузере не вызывается. */
  onOpenUrl(cb: (url: string) => void): () => void;
}

export interface SecureStorageApi {
  /** true — значения лежат в Keychain/Keystore; false (браузер) — обычное хранилище страницы, секретам там не место. */
  readonly hardwareBacked: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface FilesApi {
  /** Отдать пользователю файл: в браузере — скачивание, в оболочке — системное «Поделиться». */
  save(name: string, mime: string, data: string | Blob): Promise<void>;
}

export interface HrSample { bpm: number; contact: boolean | null; rr: number[] }
export interface HeartRateDevice { id: string; name: string }
export interface HeartRateLink { close(): Promise<void> }
export interface HeartRateApi {
  /** Причина, по которой пульсометр здесь недоступен, или null. */
  unsupportedReason(): string | null;
  /** Системный выбор датчика. null — пользователь отказался. Бросает Error с понятным текстом, если Bluetooth недоступен. */
  pick(): Promise<HeartRateDevice | null>;
  /** Одно подключение: onSample на каждое измерение, onLost при потере связи (переподключением занимается вызывающий). */
  connect(id: string, handlers: { onSample(s: HrSample): void; onLost(): void }): Promise<HeartRateLink>;
}

export interface BackupFile { name: string; size: number; mtime: number }
export interface BackupStoreApi {
  /** Автобэкап возможен только там, где есть своя файловая область приложения (нативная оболочка). */
  readonly available: boolean;
  write(name: string, text: string): Promise<void>;
  list(): Promise<BackupFile[]>;
  read(name: string): Promise<string>;
  remove(name: string): Promise<void>;
}

export interface ScannerApi {
  /** Есть ли сканер QR-кодов камерой (нативная оболочка). */
  readonly available: boolean;
  /** Открывает камеру и возвращает текст первого QR-кода; null — пользователь закрыл сканер. Бросает Error, если нет доступа к камере. */
  scanQr(): Promise<string | null>;
}

export interface SpeechApi {
  /** Есть ли озвучка (в браузере — Web Speech, в оболочке — системный TTS). Без неё подсказки просто молчат. */
  readonly available: boolean;
  /** true — речь слышна и при погашенном экране и свёрнутом приложении (нативный TTS). В браузере в фоне она может замолкать. */
  readonly background: boolean;
  /** Произносит текст; промис завершается, когда договорил, оборвали или случилась ошибка (ошибки не пробрасываются). */
  speak(text: string, lang?: string): Promise<void>;
  stop(): Promise<void>;
}

/** Локальное хранилище готовых аудиофайлов озвучки (Fish): в оболочке — Directory.Data/tts, в браузере — Cache Storage. */
export interface AudioFileInfo { name: string; bytes: number }
export interface AudioHandle { url: string; /** Освободить временный адрес (object URL в браузере). */ release(): void }
export interface AudioStoreApi {
  readonly available: boolean;
  put(name: string, data: Blob): Promise<void>;
  has(name: string): Promise<boolean>;
  /** Адрес для воспроизведения локального файла; null — файла нет. Сети не касается. */
  open(name: string): Promise<AudioHandle | null>;
  remove(name: string): Promise<void>;
  list(): Promise<AudioFileInfo[]>;
}

export interface AudioPlayerApi {
  /** Играет файл по адресу. 'ended' — доиграл или оборвали; 'failed' — звук не пошёл (тогда вызывающий говорит системным голосом). */
  play(url: string): Promise<'ended' | 'failed'>;
  stop(): Promise<void>;
}

export interface AppInfo { native: boolean; os: 'android' | 'ios' | 'web'; version: string }

export interface Platform {
  readonly info: AppInfo;
  geo: GeoApi;
  notifications: NotificationsApi;
  wakeLock: WakeLockApi;
  haptics: HapticsApi;
  lifecycle: LifecycleApi;
  secureStorage: SecureStorageApi;
  files: FilesApi;
  heartRate: HeartRateApi;
  backups: BackupStoreApi;
  scanner: ScannerApi;
  speech: SpeechApi;
  audioStore: AudioStoreApi;
  audioPlayer: AudioPlayerApi;
}
