import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { putBody, softDelete } from '../db/repo';
import type { BodyEntry } from '../domain/types';
import { formatNum, parseDate, todayStr, uid } from '../lib';
import { LineChart } from '../ui/Charts';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';

const shortDate = (s: string) => parseDate(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');

// Вес и талия: данные остаются на устройствах и на твоём ПК, ассистенту они не передаются
type BodyPeriod = '30' | '90' | 'all';

export function BodySection() {
  const [adding, setAdding] = useState(false);
  const [period, setPeriod] = useState<BodyPeriod>('90');
  const rows = useLiveQuery(() => db.body.toArray().then((r) => r.filter((x) => !x.deletedAt).sort((a, b) => a.date.localeCompare(b.date))), [], [] as BodyEntry[]);
  const weights = useMemo(() => rows.filter((r) => r.weightKg !== undefined), [rows]);
  const latest = weights[weights.length - 1];
  const periodRows = useMemo(() => {
    if (period === 'all') return rows;
    const from = new Date(parseDate(todayStr()).getTime() - Number(period) * 86400000).toISOString().slice(0, 10);
    return rows.filter((r) => r.date >= from);
  }, [rows, period]);
  const periodWeights = periodRows.filter((r) => r.weightKg !== undefined);
  const periodWaists = periodRows.filter((r) => r.waistCm !== undefined);
  const delta = useMemo(() => {
    if (!latest) return null;
    const from = new Date(parseDate(latest.date).getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const base = weights.find((w) => w.date >= from && w.id !== latest.id);
    return base ? Math.round((latest.weightKg! - base.weightKg!) * 10) / 10 : null;
  }, [weights, latest]);
  const lastWaist = [...rows].reverse().find((r) => r.waistCm !== undefined);

  return (
    <div className="section">
      <h2>Тело</h2>
      {rows.length === 0 ? (
        <p className="empty">Записывай вес и талию раз в неделю: здесь появится график динамики.</p>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="bignum" style={{ fontSize: 30, paddingTop: 8 }}>{latest ? formatNum(latest.weightKg!) : '—'}</div><div className="sub">кг сейчас</div></div>
            <div className="kpi"><div className="bignum" style={{ fontSize: 30, paddingTop: 8 }}>{delta === null ? '—' : (delta > 0 ? '+' : '') + formatNum(delta)}</div><div className="sub">кг за 30 дней</div></div>
            <div className="kpi"><div className="bignum" style={{ fontSize: 30, paddingTop: 8 }}>{lastWaist ? formatNum(lastWaist.waistCm!) : '—'}</div><div className="sub">см талия</div></div>
          </div>
          <div className="seg three" data-i={(['30', '90', 'all'] as BodyPeriod[]).indexOf(period)} role="group" aria-label="Период" style={{ marginBottom: 8 }}>
            {([['30', '30 дней'], ['90', '90 дней'], ['all', 'Всё время']] as const).map(([k, l]) => (
              <button key={k} className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{l}</button>
            ))}
          </div>
          {periodWeights.length > 0 && <LineChart points={periodWeights.map((w) => ({ label: shortDate(w.date), value: w.weightKg! }))} trend />}
          {periodWaists.length > 1 && (
            <>
              <h3 style={{ margin: '16px 0 4px', fontSize: 16 }}>Талия, см</h3>
              <LineChart points={periodWaists.map((w) => ({ label: shortDate(w.date), value: w.waistCm! }))} unit="см" trend />
            </>
          )}
          <div className="list" style={{ marginTop: 8 }}>
            {[...rows].reverse().slice(0, 4).map((r) => (
              <div key={r.id} className="row">
                <div className="grow"><div className="title">{shortDate(r.date)}</div><div className="meta">{[r.weightKg !== undefined && `${formatNum(r.weightKg)} кг`, r.waistCm !== undefined && `талия ${formatNum(r.waistCm)} см`].filter(Boolean).join(' · ')}</div></div>
                <button className="btn small ghost" aria-label={`Удалить замер за ${shortDate(r.date)}`} onClick={() => { if (confirm('Удалить этот замер?')) void softDelete('body', r.id); }}>Удалить</button>
              </div>
            ))}
          </div>
        </>
      )}
      <button className="btn block" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>Записать замер</button>
      {adding && <BodySheet existing={rows} onClose={() => setAdding(false)} />}
    </div>
  );
}

function BodySheet({ existing, onClose }: { existing: BodyEntry[]; onClose: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(todayStr());
  const [w, setW] = useState('');
  const [waist, setWaist] = useState('');
  const num = (s: string) => parseFloat(s.replace(',', '.'));
  const weight = num(w), wc = num(waist);
  const okW = w.trim() === '' || (Number.isFinite(weight) && weight >= 20 && weight <= 400);
  const okC = waist.trim() === '' || (Number.isFinite(wc) && wc >= 30 && wc <= 250);
  const any = w.trim() !== '' || waist.trim() !== '';
  const valid = okW && okC && any && /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= todayStr();

  const save = async () => {
    const prev = existing.find((x) => x.date === date); // один замер на дату: дополняем, а не дублируем
    await putBody({
      id: prev?.id ?? uid(), createdAt: prev?.createdAt ?? Date.now(), date,
      ...(w.trim() !== '' ? { weightKg: Math.round(weight * 10) / 10 } : prev?.weightKg !== undefined ? { weightKg: prev.weightKg } : {}),
      ...(waist.trim() !== '' ? { waistCm: Math.round(wc * 10) / 10 } : prev?.waistCm !== undefined ? { waistCm: prev.waistCm } : {})
    });
    toast('Замер сохранён');
    onClose();
  };

  return (
    <Sheet title="Замер тела" onClose={onClose}>
      <div className="field"><label htmlFor="b-date">Дата</label><input id="b-date" className="input" type="date" max={todayStr()} value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div className="field"><label htmlFor="b-w">Вес, кг</label><input id="b-w" className="input" inputMode="decimal" value={w} onChange={(e) => setW(e.target.value)} placeholder="например, 78,4" /></div>
      <div className="field"><label htmlFor="b-c">Талия, см (необязательно)</label><input id="b-c" className="input" inputMode="decimal" value={waist} onChange={(e) => setWaist(e.target.value)} /></div>
      {(!okW || !okC) && <p className="msg-error">Проверь значения: вес 20–400 кг, талия 30–250 см.</p>}
      <button className="btn primary block" disabled={!valid} onClick={() => void save()}>Сохранить</button>
    </Sheet>
  );
}
