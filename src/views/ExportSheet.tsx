import { useState } from 'react';
import { backupJson, download, routesGpx, workoutsCsv } from '../db/exporter';
import { addDays, toDateStr } from '../lib';
import { useSettings } from '../state/settings';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { db } from '../db/db';
import { toCSV, toHevy, bodyToCSV } from '../db/exporters';

type Preset = 'all' | '30' | '90' | 'year' | 'custom';
const PRESETS: { id: Preset; label: string }[] = [{ id: 'all', label: 'Всё время' }, { id: '30', label: '30 дней' }, { id: '90', label: '90 дней' }, { id: 'year', label: 'Этот год' }, { id: 'custom', label: 'Свой период' }];

export function ExportSheet({ onClose }: { onClose: () => void }) {
  const { settings } = useSettings();
  const toast = useToast();
  const [preset, setPreset] = useState<Preset>('all');
  const [from, setFrom] = useState(toDateStr(addDays(new Date(), -30)));
  const [to, setTo] = useState(toDateStr(new Date()));
  const today = new Date();

  const range = (): { from?: string; to?: string } => {
    if (preset === 'all') return {};
    if (preset === 'custom') return { from: from || undefined, to: to || undefined };
    if (preset === 'year') return { from: `${today.getFullYear()}-01-01` };
    return { from: toDateStr(addDays(today, -Number(preset))) };
  };
  const bad = preset === 'custom' && !!from && !!to && from > to;
  const tag = () => { const r = range(); return r.from ? `${r.from}_${r.to ?? 'now'}` : toDateStr(today); };

  return (
    <Sheet title="Экспорт за период" onClose={onClose}>
      <div className="chips wrap" role="group" aria-label="Период">
        {PRESETS.map((p) => <button key={p.id} className={'chip' + (preset === p.id ? ' on' : '')} aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>{p.label}</button>)}
      </div>
      {preset === 'custom' && (
        <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
          <input className="input" type="date" aria-label="С даты" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input className="input" type="date" aria-label="По дату" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      )}
      {bad && <p className="msg-error">Дата начала позже даты окончания.</p>}
      <div className="export-list">
        <button className="btn block" disabled={bad} onClick={async () => { download(`trenirovki-${tag()}.json`, await backupJson(range()), 'application/json'); toast('Резервная копия сохранена'); }}>Резервная копия (JSON)</button>
        <p className="sub">Можно импортировать обратно. Содержит тренировки, маршруты и замеры за период, а также справочник и шаблоны.</p>
        <button className="btn block" disabled={bad} onClick={async () => { download(`trenirovki-${tag()}.csv`, await workoutsCsv(range()), 'text/csv;charset=utf-8'); toast('Таблица сохранена'); }}>Таблица тренировок (CSV)</button>
        <p className="sub">Каждый подход отдельной строкой: открывается в Excel и Google Таблицах.</p>
        <button className="btn block" disabled={bad} onClick={async () => {
          const [ws, exs] = await Promise.all([db.workouts.toArray(), db.exercises.toArray()]);
          const exMap = new Map(exs.map(e=>[e.id,e]));
          const r = range();
          const list = r.from ? ws.filter(w=>w.date>=r.from! && w.date<=(r.to??'9999')) : ws;
          download(`podhody-${tag()}.csv`, toCSV(list, exMap), 'text/csv;charset=utf-8');
          toast('CSV подходов скачан');
        }}>Таблица подходов (CSV)</button>
        <button className="btn block" disabled={bad} onClick={async () => {
          const [ws, exs] = await Promise.all([db.workouts.toArray(), db.exercises.toArray()]);
          const exMap = new Map(exs.map(e=>[e.id,e]));
          const r = range();
          const list = r.from ? ws.filter(w=>w.date>=r.from! && w.date<=(r.to??'9999')) : ws;
          download(`hevy-${tag()}.json`, toHevy(list, exMap), 'application/json');
          toast('Hevy/Strong JSON скачан');
        }}>Hevy/Strong JSON</button>
        <button className="btn block" onClick={async () => {
          const body = await db.body.toArray();
          download(`zamery-${tag()}.csv`, bodyToCSV(body), 'text/csv;charset=utf-8');
          toast('Замеры тела CSV скачаны');
        }}>Замеры тела CSV</button>
        <button className="btn block" disabled={bad} onClick={async () => {
          const { xml, count } = await routesGpx(range(), settings.privacyZoneM);
          if (!count) { toast('За этот период нет маршрутов'); return; }
          download(`marshruty-${tag()}.gpx`, xml, 'application/gpx+xml');
          toast(`Маршрутов в файле: ${count}`);
        }}>Все маршруты (GPX)</button>
        <p className="sub">{settings.privacyZoneM > 0 ? `Начало и конец каждого маршрута скрыты (${settings.privacyZoneM} м).` : 'Зона приватности выключена: маршруты начинаются и заканчиваются у дома. Её можно включить в настройках.'}</p>
      </div>
    </Sheet>
  );
}
