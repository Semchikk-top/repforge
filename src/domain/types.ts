// Модель данных. Каждая сущность готова к синхронизации:
// id (uuid), updatedAt (мс), deletedAt (мягкое удаление), deviceId (кто правил последним).

export type ID = string;

export interface SyncMeta {
  id: ID;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
  deviceId: string;
}

export type MuscleGroup =
  | 'chest' | 'back' | 'legs' | 'glutes' | 'shoulders'
  | 'biceps' | 'triceps' | 'core' | 'calves' | 'forearms' | 'cardio';

export type Sport = 'run' | 'walk' | 'bike';

export interface Exercise extends SyncMeta {
  name: string;
  muscle: MuscleGroup;
  equipment: string;
  restSec?: number; // индивидуальный отдых, иначе берётся из настроек
  sport?: Sport;    // для кардио; если не задан, определяется по названию
  note?: string;
  custom: boolean;
}

// Тип подхода: обычный, дроп-сет (сразу снижаем вес) или rest-pause (короткая пауза и ещё повторы)
export type SetKind = 'normal' | 'drop' | 'restpause';
export const SET_KIND_LABELS: Record<SetKind, string> = { normal: 'Обычный', drop: 'Дроп-сет', restpause: 'Rest-pause' };
export const SET_KIND_SHORT: Record<SetKind, string> = { normal: '', drop: 'Д', restpause: 'RP' };

export interface SetEntry {
  id: ID;
  weight: number; // кг
  reps: number;
  done: boolean;
  completedAt?: number;
  kind?: SetKind;  // не задан = обычный
  note?: string;   // техника, самочувствие
  rpe?: number;    // усилие 6–10 (10 — больше не мог бы ни одного повторения)
  warmup?: boolean; // разминка: не входит в объём, рекорды и рейтинги; не задан = рабочий подход
  startedAt?: number; // момент нажатия «Начать» (только у первого подхода упражнения); см. domain/setTiming.ts
  workSec?: number;   // время выполнения подхода, секунды: от начала до галочки, без отдыха
}

// Результат кардио-упражнения (бег, ходьба, велосипед). У таких упражнений sets пустой.
export interface CardioEntry {
  source: 'gps' | 'manual';
  distanceM: number;
  durationSec: number;      // время движения без пауз
  elevGainM?: number;
  splits?: number[];        // секунды на каждый полный километр
  best?: Record<string, number>; // лучшее время на 1, 5, 10 км (ключ — метры)
  trackId?: ID;
  hrAvg?: number;           // средний пульс (вводится вручную), уд/мин
  hrMax?: number;           // максимальный пульс за тренировку
  place?: CardioPlace;      // где была тренировка; у старых записей не задано (неизвестно)
  laps?: IntervalLap[];     // отрезки интервальной тренировки, в порядке выполнения
}

// ---------- интервальные кардиотренировки ----------

/** Длина отрезка: по времени (секунды) или по дистанции (метры). */
export type IntervalLength = { by: 'time'; sec: number } | { by: 'distance'; m: number };
/** Цель отрезка: темп (для велосипеда это скорость, внутри всегда секунды на километр) или пульсовая зона. */
export type IntervalTarget = { kind: 'pace'; secPerKm: number } | { kind: 'zone'; zone: 1 | 2 | 3 | 4 | 5 };
export interface IntervalPhase { length: IntervalLength; target?: IntervalTarget }
/** Разминка, reps × (работа + отдых), заминка. Отдыха после последней работы нет. */
export interface IntervalPlan { warmup?: IntervalLength; reps: number; work: IntervalPhase; rest?: IntervalPhase; cooldown?: IntervalLength }
export type IntervalRole = 'warmup' | 'work' | 'rest' | 'cooldown';
export const INTERVAL_ROLE_LABELS: Record<IntervalRole, string> = { warmup: 'Разминка', work: 'Работа', rest: 'Отдых', cooldown: 'Заминка' };
/** Итог одного отрезка. skipped — пропущен кнопкой, partial — запись завершили посреди отрезка. */
export interface IntervalLap { role: IntervalRole; sec: number; distanceM: number; skipped?: boolean; partial?: boolean }

// Где проходит кардио: на улице (GPS, карта, навигация, голос) или в помещении (ручной ввод, дорожка)
export type CardioPlace = 'outdoor' | 'indoor';
export const PLACE_LABELS: Record<CardioPlace, string> = { outdoor: 'На улице', indoor: 'В помещении' };

export interface LatLon { lat: number; lon: number }
export type RouteProfile = 'pedestrian' | 'bicycle';

// Манёвр построенного маршрута (по ответу Valhalla). Расстояния в метрах, время в секундах.
export interface NavManeuver {
  type: number;         // код манёвра Valhalla (4–6: пункт назначения)
  instruction: string;  // текст для экрана
  alert?: string;       // голос заранее: «Поверните налево.»
  verbal?: string;      // голос у поворота: «Поверните налево на улицу Ленина.»
  street?: string;
  lengthM: number;      // длина участка после манёвра
  timeSec: number;
  shapeIndex: number;   // номер точки в PlannedRoute.shape, где манёвр начинается
  via?: boolean;        // промежуточная точка маршрута, а не конец
}

// План маршрута нужен только активной тренировке: хранится в ActiveRecording, в историю (CardioEntry) не попадает.
export interface PlannedRoute {
  profile: RouteProfile;
  waypoints: LatLon[];
  shape: LatLon[];
  distanceM: number;
  durationSec: number;
  maneuvers: NavManeuver[];
}

export interface WorkoutExercise {
  id: ID;
  exerciseId: ID;
  sets: SetEntry[];
  group?: ID;       // упражнения подряд с одним group образуют суперсет
  cardio?: CardioEntry;
  note?: string;
}

export type WorkoutStatus = 'planned' | 'active' | 'done';

export interface Workout extends SyncMeta {
  date: string; // YYYY-MM-DD (локальная дата)
  title: string;
  status: WorkoutStatus;
  startedAt?: number;
  finishedAt?: number;
  exercises: WorkoutExercise[];
  note?: string;
  programId?: ID;    // тренировка создана программой
  programSlot?: string; // «программа:неделя:день»: чтобы не назначать одно и то же дважды
  templateId?: ID;  // тренировка создана из этого шаблона: после неё можно предложить сохранить новый порядок упражнений
  imported?: boolean; // перенесена из другого приложения: в аналитике и рекордах есть, опыта, монет и достижений не даёт
}

// Маршрут хранится отдельной записью: он тяжёлый и нужен только на экране кардио
export interface Track extends SyncMeta {
  workoutId: ID;
  points: [number, number, number, number | null][]; // см. cardio/geo.ts
}

// Замеры тела: вес и талия на дату
export interface BodyEntry extends SyncMeta {
  date: string;
  weightKg?: number;
  waistCm?: number;
}

// Чек-ин самочувствия: один тип записи и два слота. Утро и вечер сравнимы, потому что ядро метрик общее.
export type CheckInSlot = 'morning' | 'evening';
export type Rating = 1 | 2 | 3 | 4 | 5;
export interface CheckIn extends SyncMeta {
  date: string;                 // YYYY-MM-DD
  slot: CheckInSlot;            // один слот на дату: id детерминирован (см. checkInId)
  energy: Rating;
  mood: Rating;
  soreness: Rating;             // болезненность мышц: 5 — сильнее всего
  stress: Rating;
  sleepHours?: number;          // только утро
  sleepQuality?: Rating;        // только утро
  sleepiness?: Rating;          // только вечер
  note?: string;
}

export interface TemplateExercise {
  exerciseId: ID;
  group?: ID;
  sets: number;
  reps: number;
  weight: number;
}

export interface Template extends SyncMeta {
  title: string;
  exercises: TemplateExercise[];
}

export type AnalyticsMode = 'basic' | 'deep';

export interface Settings {
  analyticsMode: AnalyticsMode;
  defaultRestSec: number;
  weightStep: number;
  keepAwake: boolean;
  sound: boolean;
  vibrate: boolean;
  assistantBackend?: 'cloud' | 'local' | 'agent'; // не задано: телефон -> облако, ПК -> локально
  weeklyGoalWorkouts: number; // цель недели: тренировок (0 — выключено)
  weeklyGoalKm: number;       // цель недели: километров бега и ходьбы (0 — выключено)
  privacyZoneM: number;       // сколько метров в начале и конце маршрута скрывать на экране и в GPX
  voiceCues: boolean;         // голосовые подсказки на каждом километре
  voiceNav: boolean;          // голос навигации на улице (повороты, сход с маршрута); по умолчанию выключен: включается явно
  voiceCoach: boolean;        // тренировочные подсказки (половина дистанции, пульсовая зона, темп); по умолчанию выключены
  barWeight: number;          // вес грифа для калькулятора блинов
  plates: number[];           // какие блины есть в зале (кг), от них считает калькулятор
  maxHr: number;              // максимальный пульс для зон; 0 — не задан
  theme: 'auto' | 'dark' | 'light';
  reminderEnabled: boolean;   // напоминание о тренировке по плану
  reminderTime: string;       // «HH:MM»
  checkinMorningEnabled: boolean; // напоминание об утреннем чек-ине самочувствия
  checkinMorningTime: string;     // «HH:MM»
  checkinEveningEnabled: boolean; // напоминание о вечернем чек-ине
  checkinEveningTime: string;     // «HH:MM»
  weeklyReviewEnabled: boolean;   // карточка недельного разбора на календаре (считается на устройстве)
  cleanupEnabled: boolean;    // плашка «Убери инвентарь» после последнего рабочего подхода упражнения
  autoBackup: boolean;        // автокопия раз в сутки внутри приложения (только нативная оболочка)
}

export const DEFAULT_SETTINGS: Settings = {
  analyticsMode: 'basic',
  defaultRestSec: 90,
  weightStep: 2.5,
  keepAwake: true,
  sound: true,
  vibrate: true,
  weeklyGoalWorkouts: 3,
  weeklyGoalKm: 0,
  privacyZoneM: 0,
  voiceCues: false,
  voiceNav: false,
  voiceCoach: false,
  barWeight: 20,
  plates: [25, 20, 15, 10, 5, 2.5, 1.25],
  maxHr: 0,
  theme: 'dark',
  reminderEnabled: false,
  reminderTime: '18:00',
  checkinMorningEnabled: false,
  checkinMorningTime: '08:00',
  checkinEveningEnabled: false,
  checkinEveningTime: '21:30',
  weeklyReviewEnabled: false,
  cleanupEnabled: true,
  autoBackup: true
};

export const MUSCLE_LABELS: Record<MuscleGroup, string> = {
  chest: 'Грудь',
  back: 'Спина',
  legs: 'Ноги',
  glutes: 'Ягодицы',
  shoulders: 'Плечи',
  biceps: 'Бицепс',
  triceps: 'Трицепс',
  core: 'Пресс',
  calves: 'Икры',
  forearms: 'Предплечья',
  cardio: 'Кардио'
};

// Запись журнала изменений (outbox) — основа будущей синхронизации.
export interface ChangeRecord {
  seq?: number;
  table: 'exercises' | 'workouts' | 'templates' | 'tracks' | 'body' | 'programs' | 'profile' | 'game' | 'checkins';
  entityId: ID;
  op: 'put' | 'delete';
  ts: number;
  deviceId: string;
  synced: 0 | 1;
}

// Кардио определяем по группе «кардио»; вид спорта — из упражнения или по названию
export const isCardio = (e: Pick<Exercise, 'muscle'> | undefined | null): boolean => e?.muscle === 'cardio';
export function sportOf(e: Pick<Exercise, 'name' | 'sport'>): Sport {
  if (e.sport) return e.sport;
  const n = e.name.toLowerCase();
  if (/вело|bike|cycl/.test(n)) return 'bike';
  if (/ходьб|walk|прогулк/.test(n)) return 'walk';
  return 'run';
}
export const SPORT_LABELS: Record<Sport, string> = { run: 'Бег', walk: 'Ходьба', bike: 'Велосипед' };

// Программа: цикл из недель, в каждой одни и те же дни недели с шаблонами тренировок
export interface ProgramDay { weekday: number; templateId: ID } // 1 — понедельник … 7 — воскресенье
export interface Program extends SyncMeta {
  title: string;
  startDate: string; // YYYY-MM-DD: понедельник первой недели
  weeks: number;
  days: ProgramDay[];
  archivedAt?: number | null; // архив: остаётся в истории, но не мешает в списке активных
}

// Только на этом устройстве (не синхронизируется): снимок версии, которую перезаписали с другого устройства
export interface ConflictRecord {
  id?: number;
  table: 'exercises' | 'workouts' | 'templates' | 'tracks' | 'body' | 'programs' | 'profile' | 'game' | 'checkins';
  entityId: ID;
  label: string;
  local: Record<string, unknown>;
  localUpdatedAt: number;
  remoteUpdatedAt: number;
  remoteDeviceId: string;
  at: number;
  resolved: 0 | 1;
}

// Фото прогресса: только на этом устройстве, ни на сервер, ни в экспорт не попадают
export interface Photo { id: ID; date: string; createdAt: number; dataUrl: string; thumb: string; note?: string }
