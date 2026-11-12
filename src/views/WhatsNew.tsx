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
  const [selected, setSelected] = useState<string | null>(null);

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

  const dismiss = () => { setEntries([]); setOpen(false); setSelected(null); void db.kv.put({ key: KEY, value: current() }); };
  const active = entries.find((e) => e.version === selected) ?? entries[0];
  if (!entries.length || !active) return null;
  const many = entries.length > 1;
  return (
    <>
      <div className="reminder" role="status">
        <span>Приложение обновлено до {current()}. Что нового?</span>
        <button className="btn small primary" onClick={() => setOpen(true)}>Показать</button>
        <button className="btn small ghost" onClick={dismiss}>Скрыть</button>
      </div>
      {open && (
        <Sheet title="Что нового" onClose={dismiss}>
          {many && (
            <div className="settings-tabs" role="tablist" aria-label="Версии">
              {entries.map((e) => (
                <button key={e.version} role="tab" id={`wn-tab-${e.version}`} aria-selected={active.version === e.version}
                  aria-controls="whats-new-panel" className={'chip' + (active.version === e.version ? ' on' : '')}
                  onClick={() => setSelected(e.version)}>{e.version}</button>
              ))}
            </div>
          )}
          <section id="whats-new-panel" role="tabpanel" {...(many ? { 'aria-labelledby': `wn-tab-${active.version}` } : {})}>
            <h3 style={{ margin: '0 0 6px' }}>{active.version}: {active.title}</h3>
            <ul style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 6 }}>{active.items.map((t) => <li key={t}>{t}</li>)}</ul>
          </section>
          <button className="btn block" style={{ marginTop: 14 }} onClick={dismiss}>Понятно</button>
        </Sheet>
      )}
    </>
  );
}
