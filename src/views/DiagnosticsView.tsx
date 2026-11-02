import { useCallback, useEffect, useState } from 'react';
import { go, replace } from '../state/router';
import { IconBack } from '../ui/Icons';
import { useToast } from '../ui/Toast';
import { useGame } from '../game/hooks';
import { useSyncStatus } from '../sync/useSync';
import { syncNow } from '../sync/sync';
import { clearSyncEvents } from '../sync/log';
import { clockMessage, clockProblem } from '../sync/clock';
import { buildReport, collectDiagnostics, compatibilityLine, diagnosticsUnlocked, type DiagnosticsSnapshot } from '../sync/diagnostics';

const dt = (ms: number | null) => (ms ? new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

function Line({ k, v, bad }: { k: string; v: string | number; bad?: boolean }) {
  return <div className="row"><div className="grow">{k}</div><span style={bad ? { color: 'var(--danger)' } : undefined}>{v}</span></div>;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* нет доступа к буферу: пробуем старый способ */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { ta.remove(); }
}

export default function DiagnosticsView() {
  const game = useGame();
  const allowed = diagnosticsUnlocked(game.unlocked);
  const toast = useToast();
  const st = useSyncStatus();
  const [d, setD] = useState<DiagnosticsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => { setBusy(true); try { setD(await collectDiagnostics()); } finally { setBusy(false); } }, []);
  // достижение «Разработчик» приходит из журнала с небольшой задержкой после запуска: не выгоняем сразу
  useEffect(() => { if (allowed) void refresh(); }, [allowed, refresh, st.lastAt, st.error]);
  useEffect(() => {
    if (allowed) return;
    const t = setTimeout(() => replace('settings'), 1200);
    return () => clearTimeout(t);
  }, [allowed]);

  if (!allowed) return <p className="empty">Раздел откроется после достижения «Разработчик».</p>;

  const cp = d ? clockProblem(d.sync.clock) : null;
  const srv = d && d.serverInfo && typeof d.serverInfo === 'object' ? d.serverInfo : null;

  return (
    <div>
      <div className="head-row">
        <button className="icon-btn" onClick={() => go('settings')} aria-label="К настройкам"><IconBack /></button>
        <h1 style={{ margin: 0 }}>Диагностика</h1>
      </div>
      {!d ? <p className="empty">Собираю сведения…</p> : (
        <>
          <div className="section" style={{ marginTop: 0 }}>
            <h2>Приложение</h2>
            <Line k="Версия" v={d.app.version} />
            <Line k="Протокол синхронизации" v={d.app.protocol} />
            <Line k="Схема базы на устройстве" v={d.app.dbVersion} />
            <Line k="Оболочка" v={`${d.app.native ? 'приложение' : 'браузер'} · ${d.app.os}`} />
            <Line k="Сеть" v={d.app.online ? 'есть' : 'нет'} />
            <Line k="Хранилище закреплено" v={d.storage.persisted === null ? '—' : d.storage.persisted ? 'да' : 'нет'} bad={d.storage.persisted === false} />
          </div>

          <div className="section">
            <h2>Синхронизация</h2>
            <Line k="Статус" v={!d.sync.configured ? 'не подключено' : d.sync.unauthorized ? 'токен отклонён' : d.sync.error ? 'ошибка' : 'в порядке'} bad={!!d.sync.error || d.sync.unauthorized} />
            <Line k="Совместимость" v={compatibilityLine(d)} bad={!!d.sync.incompat} />
            <Line k="Последняя успешная" v={dt(d.sync.lastAt)} />
            <Line k="В очереди" v={d.sync.pending} />
            <Line k="Открытых конфликтов" v={d.sync.conflictsOpen} bad={d.sync.conflictsOpen > 0} />
            <Line k="Позиция на сервере" v={d.sync.since} />
            <Line k="Часы" v={d.sync.clock ? `${d.sync.clock.offsetMs >= 0 ? '+' : '−'}${Math.round(Math.abs(d.sync.clock.offsetMs) / 1000)} с` : 'не измерялись'} bad={!!cp} />
            {d.sync.error && <p className="sub" style={{ color: 'var(--danger)' }}>{d.sync.error}</p>}
            {cp && <p className="sub" style={{ color: 'var(--danger)' }}>{clockMessage(cp)}</p>}
            <button className="btn block" style={{ marginTop: 8 }} disabled={!d.sync.configured || st.syncing} onClick={() => void syncNow().then(refresh)}>Синхронизировать сейчас</button>
          </div>

          <div className="section">
            <h2>Сервер</h2>
            {d.serverInfo === null && <p className="sub">Устройство не подключено к серверу.</p>}
            {d.serverInfo === 'unsupported' && <p className="sub">Сервер не поддерживает диагностику: он старше 0.11. Обнови сервер на ПК.</p>}
            {d.serverInfo === 'unreachable' && <p className="sub" style={{ color: 'var(--danger)' }}>Сервер не ответил.</p>}
            {srv && (
              <>
                <Line k="Версия" v={srv.serverVersion} />
                <Line k="Протокол (минимум клиента)" v={`${srv.protocol} (${srv.minClientProtocol})`} />
                <Line k="Схема базы" v={srv.schema} />
                <Line k="Python" v={srv.python} />
                <Line k="Устройств" v={srv.devices} />
                <Line k="База, МБ" v={srv.dbBytes === null ? '—' : (srv.dbBytes / 1048576).toFixed(1)} />
                <Line k="Резервных копий" v={srv.backups} bad={srv.backups === 0} />
                <Line k="Записей" v={Object.entries(srv.entities).map(([k, v]) => `${k} ${v}`).join(', ') || '—'} />
              </>
            )}
          </div>

          <div className="section">
            <h2>Данные на устройстве</h2>
            {Object.entries(d.counts).map(([k, v]) => <Line key={k} k={k} v={v} />)}
          </div>

          <div className="section">
            <h2>События</h2>
            {d.events.length === 0 && <p className="sub">Ошибок и предупреждений не было.</p>}
            {[...d.events].reverse().slice(0, 15).map((e, i) => (
              <div key={i} className="row">
                <div className="grow">
                  <div style={e.kind === 'error' ? { color: 'var(--danger)' } : undefined}>{e.msg}{e.count > 1 ? ` ×${e.count}` : ''}</div>
                  <div className="meta">{dt(e.at)} · {e.kind}</div>
                </div>
              </div>
            ))}
            {d.events.length > 0 && <button className="btn ghost block" style={{ marginTop: 8 }} onClick={() => void clearSyncEvents().then(refresh)}>Очистить журнал</button>}
          </div>

          <div className="section">
            <button className="btn primary block" onClick={() => void copyText(buildReport(d)).then((ok) => toast(ok ? 'Отчёт скопирован' : 'Не удалось скопировать'))}>Скопировать отчёт</button>
            <p className="sub" style={{ marginTop: 8 }}>В отчёте нет токенов, адреса сервера и содержимого тренировок: только версии, счётчики и тексты ошибок.</p>
            <button className="btn block" style={{ marginTop: 8 }} disabled={busy} onClick={() => void refresh()}>Обновить</button>
          </div>
        </>
      )}
    </div>
  );
}
