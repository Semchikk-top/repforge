import { useCallback, useEffect, useState } from 'react';
import { autoBackupSupported, lastBackupAt, listAutoBackups, restoreAutoBackup, runAutoBackup } from '../db/autoBackup';
import { useSettings } from '../state/settings';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';

type Item = Awaited<ReturnType<typeof listAutoBackups>>[number];
const fmtDate = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('ru-RU');
const fmtSize = (b: number) => (b > 1_000_000 ? `${(b / 1_000_000).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1000))} КБ`);

/** Автокопии внутри приложения (только нативная оболочка). */
export function BackupSection() {
  const { settings, update } = useSettings();
  const toast = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [last, setLast] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState(false);

  const reload = useCallback(async () => { setItems(await listAutoBackups()); setLast(await lastBackupAt()); }, []);
  useEffect(() => { void reload(); }, [reload]);

  if (!autoBackupSupported()) return null;

  const now = async () => {
    setBusy(true);
    try {
      const r = await runAutoBackup({ force: true });
      toast(r === 'done' ? 'Копия сделана' : r === 'skipped-empty' ? 'Данных пока нет: копировать нечего' : 'Копия не сделана');
      await reload();
    } catch (e) { toast(e instanceof Error ? e.message : 'Не удалось сделать копию'); } finally { setBusy(false); }
  };

  const restore = async (it: Item) => {
    if (!confirm(`Восстановить данные из копии от ${fmtDate(it.parsed.date)} (версия ${it.parsed.version})? Записи из копии добавятся к текущим, совпадающие по номеру будут заменены.`)) return;
    try {
      const r = await restoreAutoBackup(it.name);
      toast(`Восстановлено: тренировок ${r.workouts}, упражнений ${r.exercises}, шаблонов ${r.templates}`);
      setList(false);
    } catch (e) { toast(e instanceof Error ? e.message : 'Не удалось восстановить'); }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <label className="row" style={{ gap: 10, alignItems: 'center' }}>
        <input type="checkbox" checked={settings.autoBackup} onChange={(e) => update({ autoBackup: e.target.checked })} />
        <span>Автокопия раз в сутки</span>
      </label>
      <p className="sub">
        Зашифрованные копии хранятся внутри приложения (последние 7, затем по одной за прошлые недели, плюс снимок перед обновлением).
        {last ? ` Последняя: ${new Date(last).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}.` : ' Пока копий нет.'}
        {' '}От потери телефона они не спасают: для этого есть синхронизация с ПК и «Экспорт» с паролем.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => void now()}>{busy ? 'Копирую…' : 'Сделать копию сейчас'}</button>
        <button className="btn" style={{ flex: 1 }} disabled={items.length === 0} onClick={() => setList(true)}>Восстановить…</button>
      </div>
      {list && (
        <Sheet title="Автокопии" onClose={() => setList(false)}>
          <div className="export-list">
            {items.map((it) => (
              <button key={it.name} className="btn block" onClick={() => void restore(it)}>
                {fmtDate(it.parsed.date)} · версия {it.parsed.version} · {fmtSize(it.size)}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}
