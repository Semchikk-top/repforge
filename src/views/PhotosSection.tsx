import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { Photo } from '../domain/types';
import { toDateStr, uid } from '../lib';
import { resizeImage } from '../ui/image';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';

const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // исходный файл: больше не берём
const label = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

// Фото прогресса лежат только на этом устройстве: ни в синхронизацию, ни в экспорт они не попадают
export function PhotosSection() {
  const toast = useToast();
  const photos = useLiveQuery(() => db.photos.orderBy('date').reverse().toArray(), [], [] as Photo[]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<string | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [compare, setCompare] = useState(false);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    let added = 0;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) { toast('Это не изображение'); continue; }
      if (f.size > MAX_PHOTO_BYTES) { toast('Файл слишком большой'); continue; }
      try {
        const [dataUrl, thumb] = await Promise.all([resizeImage(f, 1280, 0.82), resizeImage(f, 240, 0.7)]);
        await db.photos.add({ id: uid(), date: toDateStr(new Date()), createdAt: Date.now(), dataUrl, thumb });
        added++;
      } catch { toast('Не удалось обработать фото'); }
    }
    if (added) toast(added === 1 ? 'Фото добавлено' : `Добавлено фото: ${added}`);
  };

  const tap = (p: Photo) => {
    if (!pickMode) { setView(p.id); return; }
    const next = picked.includes(p.id) ? picked.filter((x) => x !== p.id) : [...picked, p.id].slice(-2);
    setPicked(next);
    if (next.length === 2) setCompare(true);
  };

  const current = photos.find((p) => p.id === view) ?? null;
  const pair = picked.map((id) => photos.find((p) => p.id === id)).filter((p): p is Photo => !!p).sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="section">
      <h2>Фото прогресса</h2>
      <p className="sub">Хранятся только на этом телефоне: на сервер и в экспорт не попадают. Если очистить данные сайта, фото пропадут.</p>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden aria-label="Выбрать фото" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
      <div className="conn-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn small primary" onClick={() => fileRef.current?.click()}>Добавить фото</button>
        {photos.length >= 2 && <button className={'btn small' + (pickMode ? ' on' : '')} aria-pressed={pickMode} onClick={() => { setPickMode(!pickMode); setPicked([]); }}>{pickMode ? 'Выбери два фото' : 'Сравнить'}</button>}
      </div>
      {photos.length === 0 && <p className="empty">Фото пока нет.</p>}
      <div className="photo-grid">
        {photos.map((p) => (
          <button key={p.id} className={'photo-thumb' + (picked.includes(p.id) ? ' picked' : '')} onClick={() => tap(p)} aria-label={`Фото от ${label(p.date)}`}>
            <img src={p.thumb} alt="" loading="lazy" />
            <span>{label(p.date)}</span>
          </button>
        ))}
      </div>

      {current && (
        <Sheet title={label(current.date)} onClose={() => setView(null)}>
          <img className="photo-full" src={current.dataUrl} alt={`Фото от ${label(current.date)}`} />
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="ph-date">Дата</label>
            <input id="ph-date" className="input" type="date" value={current.date} onChange={(e) => { if (e.target.value) void db.photos.update(current.id, { date: e.target.value }); }} />
          </div>
          <button className="btn danger block" onClick={async () => { if (confirm('Удалить это фото?')) { await db.photos.delete(current.id); setView(null); toast('Фото удалено'); } }}>Удалить фото</button>
        </Sheet>
      )}

      {compare && pair.length === 2 && (
        <Sheet title="Сравнение" onClose={() => { setCompare(false); setPicked([]); setPickMode(false); }}>
          <div className="photo-compare">
            {pair.map((p) => (
              <figure key={p.id}><img src={p.dataUrl} alt={`Фото от ${label(p.date)}`} /><figcaption>{label(p.date)}</figcaption></figure>
            ))}
          </div>
          <p className="sub" style={{ textAlign: 'center' }}>Прошло {Math.round((Date.parse(pair[1].date) - Date.parse(pair[0].date)) / 86400000)} дн.</p>
        </Sheet>
      )}
    </div>
  );
}
