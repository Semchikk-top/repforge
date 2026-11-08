import { useEffect, useState } from 'react';
import { db } from '../db/db';
import { entriesToShow, type WhatsNewEntry } from '../whatsNew';
import { Sheet } from '../ui/Sheet';

const KEY = 'app.lastSeenVersion';
const current = (): string => (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.replace(/-.*$/, '') : '0.0.0');

/**
 * Плашка после обновления. Новая установка (данных ещё нет) её не видит и просто запоминает версию.
 * Тот, у кого версия не записана, но данные есть, видит запись текущей версии один раз.
 */
export function WhatsNew({ ready }: { ready: boolean }) {
  const [entries, setEntries] = useState<WhatsNewEntry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void (async () => {
      const cur = current();
      const last = ((await db.kv.get(KEY))?.value as string | undefined) ?? null;
      if (last === cur) return;
      if (last === null && (await db.workouts.count()) === 0) { await db.kv.put({ key: KEY, value: cur }); return; }
      const e = entriesToShow(last, cur);
      if (!e.length) { await db.kv.put({ key: KEY, value: cur }); return; }
      if (alive) setEntries(e);
    })().catch(() => undefined);
    return () => { alive = false; };
  }, [ready]);

  const dismiss = () => { setEntries([]); setOpen(false); void db.kv.put({ key: KEY, value: current() }); };
  if (!entries.length) return null;
  return (
    <>
      <div className="reminder" role="status">
        <span>Приложение обновлено до {current()}. Что нового?</span>
        <button className="btn small primary" onClick={() => setOpen(true)}>Показать</button>
        <button className="btn small ghost" onClick={dismiss}>Скрыть</button>
      </div>
      {open && (
        <Sheet title={`Что нового в ${current()}`} onClose={dismiss}>
          {entries.map((e) => (
            <section key={e.version} style={{ marginBottom: 14 }}>
              <h3 style={{ margin: '0 0 6px' }}>{e.version}: {e.title}</h3>
              <ul style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 6 }}>{e.items.map((t) => <li key={t}>{t}</li>)}</ul>
            </section>
          ))}
          <button className="btn block" onClick={dismiss}>Понятно</button>
        </Sheet>
      )}
    </>
  );
}
