// Версия протокола синхронизации: на каком «языке» приложение разговаривает с сервером.
// Должна совпадать по смыслу с PROTOCOL_VERSION в server/version.py. Растёт только тогда, когда старая
// сторона не сможет корректно работать с новой (изменились поля запроса/ответа или набор таблиц).
export const PROTOCOL_VERSION = 1;

export type Incompat = 'client_outdated' | 'server_outdated';

export interface SyncFailure {
  /** Если задано, версии клиента и сервера несовместимы: повторять запрос бессмысленно, пока одну из сторон не обновят. */
  incompat: Incompat | null;
  message: string;
}

export const MSG_SERVER_OUTDATED = 'Сервер старее приложения: обнови сервер на ПК (git pull, затем bash deploy/install.sh).';
export const MSG_CLIENT_OUTDATED = 'Приложение слишком старое для этого сервера: обнови приложение.';

/**
 * Разбор отказа сервера на запрос синхронизации.
 * 426 — версия протокола не подходит (сервер 0.11+ говорит, чья сторона устарела).
 * 422 «Неизвестная таблица» — признак сервера до появления версий протокола, который не знает новой таблицы
 * (например, `game` или `checkins`): для пользователя это то же самое «сервер устарел».
 */
export function parseSyncFailure(status: number, body: unknown): SyncFailure {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 426 && detail && typeof detail === 'object') {
    const d = detail as { code?: unknown; message?: unknown };
    if (d.code === 'server_outdated') return { incompat: 'server_outdated', message: MSG_SERVER_OUTDATED };
    if (d.code === 'client_outdated') return { incompat: 'client_outdated', message: MSG_CLIENT_OUTDATED };
    return { incompat: null, message: typeof d.message === 'string' ? d.message : `Версии несовместимы (${status})` };
  }
  if (status === 422 && typeof detail === 'string' && /Неизвестная таблица/.test(detail)) {
    return { incompat: 'server_outdated', message: MSG_SERVER_OUTDATED };
  }
  return { incompat: null, message: `Ошибка сервера (${status})` };
}
