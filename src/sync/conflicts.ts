// Конфликт синхронизации: правку с этого устройства перезаписала более новая правка с другого.
// Раньше она терялась молча; теперь её снимок сохраняется, и человек решает, что оставить.
const META = new Set(['updatedAt', 'deviceId', 'id', 'seq']);

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).filter((k) => !META.has(k) && o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export const sameContent = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

export interface Row { updatedAt: number; deviceId: string; deletedAt?: number; [k: string]: unknown }

/** Нужно ли сохранить локальную версию как конфликт, прежде чем перезаписать её удалённой */
export function isConflict(opts: { local: Row | undefined; remote: { data: Record<string, unknown>; deviceId: string; deleted: boolean }; localPending: boolean; myDeviceId: string }): boolean {
  const { local, remote, localPending, myDeviceId } = opts;
  if (!local || local.deletedAt || !localPending) return false;      // у нас нет несинхронизированной правки: перезапись обычная
  if (remote.deviceId === myDeviceId) return false;                    // эхо собственной правки
  if (remote.deleted) return true;                                     // чужое удаление поверх нашей правки
  return !sameContent(local, remote.data);
}

export function conflictLabel(table: string, row: Record<string, unknown>): string {
  const s = (k: string) => (typeof row[k] === 'string' ? (row[k] as string) : '');
  switch (table) {
    case 'workouts': return `${s('date')} · ${s('title') || 'Тренировка'}`;
    case 'exercises': return s('name') || 'Упражнение';
    case 'templates': case 'programs': return s('title') || 'Без названия';
    case 'body': return `Замер ${s('date')}`;
    case 'checkins': return `Чек-ин ${s('date')} · ${s('slot') === 'evening' ? 'вечер' : 'утро'}`;
    case 'learning': return `Попытка теста ${s('date')}`;
    case 'profile': return `Профиль ${s('displayName') || 'без имени'}`;
    default: return 'Запись';
  }
}
