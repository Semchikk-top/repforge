import Dexie, { type Table } from 'dexie';
import type { BodyEntry, ChangeRecord, CheckIn, ConflictRecord, Exercise, LearningAttempt, Photo, Program, Template, Track, Workout } from '../domain/types';
import { SEED_EXERCISES } from '../domain/seed';
import type { Friend, PeerSnapshotRow, ProfileRow } from '../social/types';
import type { GameRow } from '../game/types';

export interface SyncBase {
  /** `таблица/id записи`, например workouts/abc */
  id: string;
  table: string;
  data: Record<string, unknown>;
  at: number;
}

export interface KV {
  key: string;
  value: unknown;
}

class AppDB extends Dexie {
  exercises!: Table<Exercise, string>;
  workouts!: Table<Workout, string>;
  templates!: Table<Template, string>;
  tracks!: Table<Track, string>;
  body!: Table<BodyEntry, string>;
  programs!: Table<Program, string>;
  conflicts!: Table<ConflictRecord, number>;
  photos!: Table<Photo, string>;
  changes!: Table<ChangeRecord, number>;
  kv!: Table<KV, string>;
  // Соц. часть живёт только на устройстве: не синхронизируется и не попадает в экспорт
  profile!: Table<ProfileRow, string>;
  friends!: Table<Friend, string>;
  peerSnapshots!: Table<PeerSnapshotRow, string>;
  // Игровой журнал (опыт, монеты, достижения, покупки): синхронизируется между устройствами
  game!: Table<GameRow, string>;
  // Чек-ины самочувствия (0.8): синхронизируются, один слот на дату
  checkins!: Table<CheckIn, string>;
  learning!: Table<LearningAttempt, string>;
  // Общий предок для слияния тренировок (0.11): какой версию записи отдал сервер в последний раз. Только на устройстве.
  bases!: Table<SyncBase, string>;

  constructor() {
    super('workout-pwa');
    this.version(1).stores({
      exercises: 'id, muscle, name, updatedAt',
      workouts: 'id, date, status, updatedAt',
      templates: 'id, updatedAt',
      changes: '++seq, synced, table, entityId',
      kv: 'key'
    });
    // v2: у стартовых упражнений теперь общие id на всех устройствах. Переносим старые записи.
    this.version(2)
      .stores({})
      .upgrade(async (tx) => {
        const seedByName = new Map(SEED_EXERCISES.map((s) => [s.name, s.id]));
        const exTable = tx.table('exercises');
        const idMap = new Map<string, string>();
        for (const e of (await exTable.toArray()) as Exercise[]) {
          const target = seedByName.get(e.name);
          if (!e.custom && target && e.id !== target) idMap.set(e.id, target);
        }
        if (!idMap.size) return;
        for (const [oldId, newId] of idMap) {
          const row = (await exTable.get(oldId)) as Exercise;
          await exTable.delete(oldId);
          if (!(await exTable.get(newId))) await exTable.put({ ...row, id: newId });
        }
        for (const w of (await tx.table('workouts').toArray()) as Workout[]) {
          if (w.exercises.some((we) => idMap.has(we.exerciseId))) {
            await tx.table('workouts').put({
              ...w,
              exercises: w.exercises.map((we) => ({ ...we, exerciseId: idMap.get(we.exerciseId) ?? we.exerciseId }))
            });
          }
        }
        for (const t of (await tx.table('templates').toArray()) as Template[]) {
          if (t.exercises.some((te) => idMap.has(te.exerciseId))) {
            await tx.table('templates').put({
              ...t,
              exercises: t.exercises.map((te) => ({ ...te, exerciseId: idMap.get(te.exerciseId) ?? te.exerciseId }))
            });
          }
        }
      });
    // v3: маршруты GPS-тренировок
    this.version(3).stores({ tracks: 'id, workoutId, updatedAt' });
    // v4: замеры тела
    this.version(4).stores({ body: 'id, date, updatedAt' });
    // v5: программы (синхронизируются), конфликты и фото (только на устройстве)
    this.version(5).stores({ programs: 'id, updatedAt', conflicts: '++id, at, resolved', photos: 'id, date' });
    // v6: профиль с ключом, друзья и их снимки рейтинга (только на устройстве)
    this.version(6).stores({ profile: 'id', friends: 'profileId, status', peerSnapshots: 'id, profileId' });
    // v7: игровой журнал (геймификация, 0.6)
    this.version(7).stores({ game: 'id, kind, updatedAt' });
    // v8: чек-ины самочувствия (0.8)
    this.version(8).stores({ checkins: 'id, date, [date+slot], updatedAt' });
    // v9: общие предки для слияния тренировок по подходам (0.11)
    this.version(9).stores({ bases: 'id, at' });
    this.version(10).stores({ learning: 'id, courseId, updatedAt' }); // 1.5.0: попытки тестов курсов
  }
}

export const db = new AppDB();
