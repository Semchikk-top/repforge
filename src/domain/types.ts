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
  barWeight: number;          // вес грифа для калькулятора блинов
  plates: number[];           // какие блины есть в зале (кг), от них считает калькулятор
  maxHr: number;              // максимальный пульс для зон; 0 — не задан
  theme: 'auto' | 'dark' | 'light';
  reminderEnabled: boolean;   // напоминание о тренировке по плану
  reminderTime: string;       // «HH:MM»
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
  barWeight: 20,
  plates: [25, 20, 15, 10, 5, 2.5, 1.25],
  maxHr: 0,
  theme: 'dark',
  reminderEnabled: false,
  reminderTime: '18:00'
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
  table: 'exercises' | 'workouts' | 'templates' | 'tracks' | 'body' | 'programs' | 'profile' | 'game';
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
  table: 'exercises' | 'workouts' | 'templates' | 'tracks' | 'body' | 'programs' | 'profile' | 'game';
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
