import { useEffect, useState } from 'react';
import { BACKUP_TABLES, inspectBackup, type BackupPreview, type BackupTable } from '../db/backupInspect';
import { importAll } from '../db/repo';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';

const LABEL: Record<BackupTable, string> = {
  workouts: 'Тренировки', exercises: 'Упражнения', templates: 'Шаблоны', body: 'Замеры тела',
  programs: 'Программы', checkins: 'Чек-ины', tracks: 'Треки', game: 'Игровые данные', learning: 'Попытки тестов'
};

/**
 * Предпросмотр восстановления: что добавится, что заменится, где копия уступит данным на устройстве.
 * Пока пользователь не нажал «Восстановить», в базу ничего не пишется.
 */
export function RestorePreview({ title, json, onDone, onClose }: { title: string; json: string; onDone?: () => void; onClose: () => void }) {
  const toast = useToast();
  const [p, setP] = useState<BackupPreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { let off = false; void inspectBackup(json).then((r) => { if (!off) setP(r); }); return () => { off = true; }; }, [json]);

  const apply = async () => {
    setBusy(true);
    try {
      const r = await importAll(json);
      toast(`Восстановлено: тренировок ${r.workouts}, упражнений ${r.exercises}, шаблонов ${r.templates}`);
      onDone?.(); onClose();
    } catch (e) { toast(e instanceof Error ? e.message : 'Не удалось восстановить'); } finally { setBusy(false); }
  };

  return (
    <Sheet title={title} onClose={onClose}>
      {!p ? <p className="sub">Проверяю копию…</p> : !p.ok ? (
        <>
          <p className="msg-error" role="alert">{p.error}</p>
          <button className="btn block" onClick={onClose}>Закрыть</button>
        </>
      ) : (
        <>
          <p className="sub">
            {p.exportedAt ? `Копия от ${new Date(p.exportedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}. ` : ''}
            Записи из копии добавятся к текущим. Если запись есть в обоих местах, остаётся более свежая.
          </p>
          <div className="list" aria-label="Что изменится">
            {BACKUP_TABLES.filter((t) => p.tables[t].total > 0).map((t) => {
              const d = p.tables[t];
              return (
                <div key={t} className="row">
                  <div className="grow">{LABEL[t]}</div>
                  <div className="sub">
                    {[d.add && `добавится ${d.add}`, d.replace && `заменится ${d.replace}`, d.keep && `останутся текущие ${d.keep}`, d.same && `без изменений ${d.same}`].filter(Boolean).join(' · ')}
                  </div>
                </div>
              );
            })}
          </div>
          <p style={{ margin: '10px 0' }}>
            <b>Добавится {p.totals.add}, заменится {p.totals.replace}.</b>{' '}
            {p.totals.conflicts > 0 ? `Расхождений между копией и устройством: ${p.totals.conflicts}.` : 'Расхождений нет.'}
          </p>
          {p.totals.keep > 0 && <p className="sub">{p.totals.keep} записей на устройстве новее, чем в копии: они не изменятся.</p>}
          {p.skipped > 0 && <p className="msg-error" role="status">Повреждённых записей в копии: {p.skipped}. Они будут пропущены, остальное восстановится.</p>}
          {p.hasSettings && <p className="sub">Настройки приложения тоже вернутся из копии и заменят текущие.</p>}
          <p className="sub">Ничего не удаляется: более свежие записи на устройстве остаются как есть.</p>
          <div className="conn-actions">
            <button className="btn primary" disabled={busy || (p.totals.add + p.totals.replace === 0 && !p.hasSettings)} onClick={() => void apply()}>{busy ? 'Восстанавливаю…' : 'Восстановить'}</button>
            <button className="btn" onClick={onClose}>Отмена</button>
          </div>
          {p.totals.add + p.totals.replace === 0 && !p.hasSettings && <p className="sub">В копии нет ничего нового: все записи уже есть на устройстве.</p>}
        </>
      )}
    </Sheet>
  );
}
