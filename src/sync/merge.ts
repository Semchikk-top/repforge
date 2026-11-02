// Слияние двух правок одной записи (трёхстороннее: общая основа, наша версия, чужая версия).
// Раньше при расхождении побеждала запись целиком: если на телефоне поменяли вес первого подхода, а на ПК отметили
// выполненным третий, одна из правок пропадала. Теперь сравниваем каждую правку с общей основой:
//   · изменено только с одной стороны — берём это изменение;
//   · изменено с обеих сторон по-разному — побеждает более новая запись (и мы сообщаем, что наша правка проиграла);
//   · в списках: добавленное с любой стороны остаётся; удалено с одной стороны — удаляется, если другая сторона это
//     не правила (правка важнее удаления: лучше оставить лишнее, чем потерять сделанное).
// Объекты сливаются по полям, любой глубины. Списки объектов сливаются по ключу элемента: по `id`, а если id нет
// (упражнения шаблона, дни программы), по ключу из MERGE_SPECS. Прочие списки и значения — целиком.
// Чистые функции: без базы данных и без часов.
import type { Workout } from '../domain/types';

export type Rec = Record<string, unknown>;

/** Каноническая запись для сравнения: ключи по алфавиту, undefined как отсутствие. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Rec;
    return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

/** Служебные поля верхнего уровня: при сравнении содержимого записей не считаются. */
const TOP_META = ['updatedAt', 'deviceId', 'seq'];
const strip = (w: Rec): Rec => Object.fromEntries(Object.entries(w).filter(([k]) => !TOP_META.includes(k)));
/** Одинаково ли содержимое записей (без меток времени правки и устройства). */
export const sameRecord = (a: Rec, b: Rec): boolean => canon(strip(a)) === canon(strip(b));
/** Прежнее имя: сравнение тренировок. */
export const sameWorkout = sameRecord;

type Keyer = (item: Rec, nth: number) => string;

export interface MergeSpec {
  /** Для значений, где «новее» не годится: путь поля → выбор из двух конфликтующих. */
  pick?: Record<string, (local: unknown, remote: unknown) => unknown>;
  /** Списки без id: путь списка → ключ элемента (nth — какой по счёту такой же элемент). */
  keyers?: Record<string, Keyer>;
}

interface Ctx {
  /** Побеждает ли наша версия там, где обе стороны изменили одно и то же по-разному. */
  localWins: boolean;
  /** Наша правка проиграла чужой: человеку стоит об этом знать. */
  lostLocal: boolean;
  spec: MergeSpec;
}

const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const hasId = (v: unknown): v is Rec & { id: string } => isObj(v) && typeof v.id === 'string';

/** Ключи элементов списка, если список можно сливать по элементам; иначе null. */
function keyed(path: string, lists: Array<unknown[] | undefined>, ctx: Ctx): Array<Array<{ key: string; item: Rec }> | undefined> | null {
  const present = lists.filter((x): x is unknown[] => Array.isArray(x));
  if (!present.length || !present.every((l) => l.every(isObj))) return null;
  const keyer = ctx.spec.keyers?.[path];
  const byId = present.every((l) => l.every(hasId));
  if (!byId && !keyer) return null;
  return lists.map((l) => {
    if (!l) return undefined;
    const seen = new Map<string, number>();
    return (l as Rec[]).map((item) => {
      let key: string;
      if (byId) key = (item as { id: string }).id;
      else {
        const base = keyer!(item, 0);
        const nth = seen.get(base) ?? 0;
        seen.set(base, nth + 1);
        key = `${base}#${nth}`;
      }
      return { key, item };
    });
  });
}

function mergeValue(path: string, b: unknown, l: unknown, r: unknown, ctx: Ctx): unknown {
  if (canon(l) === canon(r)) return l;
  if (canon(l) === canon(b)) return r;   // менялось только там
  if (canon(r) === canon(b)) return l;   // менялось только у нас
  // обе стороны, по-разному
  if (isObj(l) && isObj(r)) return mergeObject(path, isObj(b) ? b : undefined, l, r, ctx, []);
  if (Array.isArray(l) && Array.isArray(r)) {
    const k = keyed(path, [Array.isArray(b) ? b : undefined, l, r], ctx);
    if (k) return mergeList(path, k[0], k[1]!, k[2]!, ctx);
  }
  const v = ctx.spec.pick?.[path] ? ctx.spec.pick[path](l, r) : ctx.localWins ? l : r;
  if (canon(v) !== canon(l)) ctx.lostLocal = true;
  return v;
}

function mergeObject(path: string, base: Rec | undefined, local: Rec, remote: Rec, ctx: Ctx, skip: string[]): Rec {
  const out: Rec = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    if (skip.includes(k)) continue;
    const v = mergeValue(path ? `${path}.${k}` : k, base?.[k], local[k], remote[k], ctx);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Слияние списков по ключу. Порядок берётся от победившей стороны, чужие добавления встают за своим соседом. */
function mergeList(
  path: string,
  base: Array<{ key: string; item: Rec }> | undefined,
  local: Array<{ key: string; item: Rec }>,
  remote: Array<{ key: string; item: Rec }>,
  ctx: Ctx
): Rec[] {
  const bMap = new Map((base ?? []).map((x) => [x.key, x.item]));
  const lMap = new Map(local.map((x) => [x.key, x.item]));
  const rMap = new Map(remote.map((x) => [x.key, x.item]));
  const [first, second] = ctx.localWins ? [local, remote] : [remote, local];
  const out: Array<{ key: string; item: Rec }> = [];
  const seen = new Set<string>();
  const decide = (key: string): Rec | null => {
    const l = lMap.get(key), r = rMap.get(key), b = bMap.get(key);
    if (l && r) return mergeValue(path, b, l, r, ctx) as Rec;
    const mine = !!l;                    // элемент есть только на одной стороне
    const present = (l ?? r)!;
    if (!b) return present;              // добавлен там и не было в основе
    // был в основе, другая сторона его удалила: удаляем, если эта сторона его не трогала
    if (canon(present) === canon(b)) return null;
    if (!mine) ctx.lostLocal = true;     // мы удалили, а чужая правка сохранилась: наше удаление проиграло
    return present;                      // правка важнее удаления
  };
  for (const { key } of first) {
    seen.add(key);
    const v = decide(key);
    if (v) out.push({ key, item: v });
  }
  // элементы только из второго списка встают сразу за своим предыдущим соседом: порядок остаётся привычным
  second.forEach(({ key }, i) => {
    if (seen.has(key)) return;
    seen.add(key);
    const v = decide(key);
    if (!v) return;
    let at = out.length;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((x) => x.key === second[j].key);
      if (k >= 0) { at = k + 1; break; }
    }
    out.splice(at, 0, { key, item: v });
  });
  return out.map((x) => x.item);
}

export interface MergeResult<T> {
  merged: T;
  /** Какая-то наша правка проиграла чужой (обе стороны меняли одно и то же). */
  lostLocal: boolean;
}

const ENTITY_SKIP = ['id', 'createdAt', 'updatedAt', 'deviceId', 'deletedAt'];

/**
 * Слияние записей. `base` — версия, которую сервер отдал нам в прошлый раз (общий предок); без неё каждое поле
 * считается изменённым с обеих сторон, и совпадать должны только равные значения.
 * `localWins` — какая запись новее по (updatedAt, deviceId): её значения выбираются при настоящем споре.
 * Метки времени обновления и устройство проставляет вызывающий: здесь их нет.
 */
export function mergeEntity<T extends Rec>(base: T | undefined, local: T, remote: T, localWins: boolean, spec: MergeSpec = {}): MergeResult<T> {
  const ctx: Ctx = { localWins, lostLocal: false, spec };
  const fields = mergeObject('', base, local, remote, ctx, ENTITY_SKIP);
  const merged = { ...fields, id: local.id, createdAt: Math.min(Number(local.createdAt) || 0, Number(remote.createdAt) || 0) || local.createdAt } as unknown as T;
  return { merged, lostLocal: ctx.lostLocal };
}

const STATUS_RANK: Record<string, number> = { planned: 0, active: 1, done: 2 };
const furthest = (l: unknown, r: unknown) => ((STATUS_RANK[String(l)] ?? 0) >= (STATUS_RANK[String(r)] ?? 0) ? l : r);

/** Особенности таблиц. Таблицы, которых здесь нет (tracks, profile), по-прежнему разрешаются целой записью. */
export const MERGE_SPECS: Record<string, MergeSpec> = {
  // подходы и упражнения тренировки имеют id; статус берём самый продвинутый, а не самый новый
  workouts: { pick: { status: furthest } },
  exercises: {},
  // у упражнений шаблона и дней программы id нет: узнаём по упражнению и по дню недели
  templates: { keyers: { exercises: (i) => String(i.exerciseId) + '/' + String(i.group ?? '') } },
  programs: { keyers: { days: (i) => String(i.weekday) } },
  body: {},
  checkins: {},
  game: {}
};

/** Прежнее имя: слияние тренировок. */
export const mergeWorkout = (base: Workout, local: Workout, remote: Workout, localWins: boolean): MergeResult<Workout> =>
  mergeEntity(base as unknown as Rec, local as unknown as Rec, remote as unknown as Rec, localWins, MERGE_SPECS.workouts) as unknown as MergeResult<Workout>;
