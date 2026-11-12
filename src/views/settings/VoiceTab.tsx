import { useCallback, useEffect, useRef, useState } from 'react';
import { platform } from '../../platform';
import { useSettings } from '../../state/settings';
import { useSyncStatus } from '../../sync/useSync';
import { Toggle } from '../../ui/Toggle';
import { useToast } from '../../ui/Toast';
import { deleteVoice, fetchAudio, getTtsStatus, listVoices, synthesize, type TtsStatus, type TtsVoice } from '../../tts/api';
import { manifest } from '../../tts/cache';
import { staticTexts } from '../../tts/classify';
import { clearAll, dropVoice, prepareStaticPack, spokenText, syncParams, usage, type PackProgress, type PackResult } from '../../tts/packs';
import { AddVoiceSheet } from './AddVoiceSheet';

const mb = (b: number) => (b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',');
const TEST_PHRASE = 'Проверка озвучки. Вперёд, ты справишься.';

function resultText(r: PackResult): string {
  if (r.aborted) return `Остановлено: готово ${r.ok + r.skipped} из ${r.total}. Можно продолжить с того же места.`;
  if (r.fatal) return `${r.fatal}. Готово ${r.ok + r.skipped} из ${r.total}: остальное прозвучит системным голосом.`;
  if (r.failed) return `Готово ${r.ok + r.skipped} из ${r.total}, не вышло ${r.failed}: эти фразы прозвучат системным голосом.`;
  return r.ok ? `Готово: ${r.total} фраз, новых ${r.ok}.` : `Всё уже готово: ${r.total} фраз на устройстве.`;
}

export function VoiceTab() {
  const { settings, update } = useSettings();
  const sync = useSyncStatus();
  const toast = useToast();
  const paired = !!sync.configured && !sync.unauthorized;
  const fish = settings.ttsEngine === 'fish';

  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [adding, setAdding] = useState(false);
  const [progress, setProgress] = useState<PackProgress | null>(null);
  const [packMsg, setPackMsg] = useState<string | null>(null);
  const [ready, setReady] = useState(0);
  const [stored, setStored] = useState<{ files: number; bytes: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [studio, setStudio] = useState('');
  const [studioBusy, setStudioBusy] = useState(false);
  const [studioMsg, setStudioMsg] = useState<string | null>(null);
  const [lastClip, setLastClip] = useState<Blob | null>(null);

  const totalStatic = staticTexts().length;
  const recount = useCallback(() => {
    setReady(settings.ttsVoiceId ? staticTexts().filter((t) => manifest().has(settings.ttsVoiceId, t)).length : 0);
    void usage().then(setStored).catch(() => setStored(null));
  }, [settings.ttsVoiceId]);
  useEffect(recount, [recount, progress]);

  const refresh = useCallback(async () => {
    if (!paired) return;
    setStatusErr(null);
    try { setStatus(await getTtsStatus()); setVoices(await listVoices()); }
    catch (e) { setStatus(null); setStatusErr(e instanceof Error ? e.message : 'Сервер недоступен'); }
  }, [paired]);
  useEffect(() => { if (fish) void refresh(); }, [fish, refresh]);
  useEffect(() => () => abort.current?.abort(), []);

  const chooseVoice = async (id: string) => {
    update({ ttsVoiceId: id });
    try { await syncParams(id); } catch { /* без связи пак сменится при следующей подготовке */ }
    recount();
  };

  const removeVoice = async (v: TtsVoice) => {
    if (!confirm(`Удалить голос «${v.name}»? Образец исчезнет с ПК, готовая озвучка с этого телефона тоже.`)) return;
    try {
      await deleteVoice(v.id);
      await dropVoice(v.id);
      if (settings.ttsVoiceId === v.id) update({ ttsVoiceId: '' });
      await refresh(); recount();
    } catch (e) { toast(e instanceof Error ? e.message : 'Не удалось удалить голос'); }
  };

  const prepare = async () => {
    if (!settings.ttsVoiceId) return;
    abort.current = new AbortController();
    setPackMsg(null); setProgress({ done: 0, total: totalStatic, failed: 0 });
    const r = await prepareStaticPack(settings.ttsVoiceId, { signal: abort.current.signal, onProgress: setProgress });
    setProgress(null);
    setPackMsg(r === 'busy' ? 'Озвучка уже готовится в другом месте.' : resultText(r));
    recount();
    void refresh();
  };

  const play = async (text: string) => {
    if (!settings.ttsVoiceId) return;
    setStudioBusy(true); setStudioMsg(null);
    try {
      const info = await synthesize(settings.ttsVoiceId, spokenText(text));
      const blob = await fetchAudio(info.hash);
      setLastClip(blob);
      const url = URL.createObjectURL(blob);
      const r = await platform.audioPlayer.play(url);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStudioMsg(r === 'failed' ? 'Не удалось воспроизвести файл: его можно сохранить и открыть в плеере.' : info.cached ? 'Из кеша ПК.' : 'Готово.');
    } catch (e) { setStudioMsg(e instanceof Error ? e.message : 'Не удалось озвучить'); }
    finally { setStudioBusy(false); }
  };

  const saveClip = async () => {
    if (!lastClip) return;
    await platform.files.save(`ozvuchka.${lastClip.type.includes('wav') ? 'wav' : 'mp3'}`, lastClip.type || 'audio/mpeg', lastClip);
  };

  const wipe = async () => {
    if (!confirm('Удалить всю озвучку Fish с этого устройства? Голоса на ПК останутся, пак можно собрать заново.')) return;
    await clearAll(); recount(); setPackMsg(null);
  };

  const noStorage = !platform.audioStore.available;

  return (
    <>
      <div className="section" style={{ marginTop: 0 }}>
        <h2>Голос подсказок</h2>
        <div className="seg" data-i={fish ? 1 : 0} role="group" aria-label="Движок озвучки">
          <button className={!fish ? 'on' : ''} onClick={() => update({ ttsEngine: 'system' })}>Системный</button>
          <button className={fish ? 'on' : ''} disabled={!paired || noStorage} onClick={() => update({ ttsEngine: 'fish' })}>Fish Speech</button>
        </div>
        <p className="sub" style={{ marginTop: 8 }}>
          {!paired ? 'Fish Speech работает на твоём ПК: сначала подключи устройство во вкладке «Сервер».'
            : noStorage ? 'В этом браузере некуда сохранять готовую озвучку: Fish здесь недоступен.'
            : fish ? 'Статические фразы и маршрут звучат голосом Fish из памяти телефона. Километры, темп, пульс и итоги всегда читает системный голос.'
            : 'Системный голос телефона читает все подсказки.'}
        </p>
      </div>

      {fish && paired && (
        <>
          <div className="section">
            <h2>Fish Speech</h2>
            <p className="sub" role="status">
              {status ? (status.reachable ? `ПК отвечает${status.latencyMs !== null ? `, ${status.latencyMs} мс` : ''}.` : status.message) : statusErr ?? 'Проверяю…'}
              {status && !status.reachable ? ' Адрес и ключ — во вкладке «Сервер».' : ''}
            </p>

            <div className="list">
              {voices.map((v) => (
                <div className="row" key={v.id}>
                  <div className="grow">
                    <div>{v.name}</div>
                    <div className="meta">{v.durationSec ? `образец ${Math.round(v.durationSec)} с` : 'образец'}{settings.ttsVoiceId === v.id ? ' · выбран' : ''}</div>
                  </div>
                  <button className="btn small" aria-pressed={settings.ttsVoiceId === v.id} disabled={settings.ttsVoiceId === v.id} onClick={() => void chooseVoice(v.id)}>Выбрать</button>
                  <button className="btn small ghost" aria-label={`Удалить голос ${v.name}`} onClick={() => void removeVoice(v)}>Удалить</button>
                </div>
              ))}
              {!voices.length && <p className="empty">Голосов пока нет. Готовых голосов у Fish Speech нет: загрузи запись своего голоса (10–30 секунд) вместе с текстом.</p>}
            </div>
            <button className="btn block" style={{ marginTop: 8 }} onClick={() => setAdding(true)}>Добавить голос</button>
            {adding && <AddVoiceSheet onClose={() => setAdding(false)} onAdded={(v) => { void refresh(); void chooseVoice(v.id); }} />}
          </div>

          <div className="section">
            <h2>Подготовка озвучки</h2>
            <p className="sub">Готовые фразы (запись, маршрут, пульсовые зоны) собираются на ПК и сохраняются в память телефона. Дальше сеть не нужна. Для нового маршрута недостающее готовится при его построении.</p>
            <p className="sub" style={{ marginTop: 6 }}>Готово {ready} из {totalStatic} постоянных фраз.</p>
            {progress && (
              <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="tts-bar"><i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
            )}
            {packMsg && <p className="sub" role="status">{packMsg}</p>}
            {progress ? (
              <button className="btn block" style={{ marginTop: 8 }} onClick={() => abort.current?.abort()}>Остановить ({progress.done} из {progress.total})</button>
            ) : (
              <button className="btn primary block" style={{ marginTop: 8 }} disabled={!settings.ttsVoiceId} onClick={() => void prepare()}>Подготовить озвучку</button>
            )}
            <p className="sub" style={{ marginTop: 8 }}>На телефоне: {stored ? `${stored.files} файлов, ${mb(stored.bytes)} МБ` : '—'}{status ? `. Кеш на ПК: ${status.cache.files} файлов, ${mb(status.cache.bytes)} МБ` : ''}.</p>
            <button className="btn block ghost" style={{ marginTop: 8 }} disabled={!stored?.files} onClick={() => void wipe()}>Удалить озвучку с устройства</button>
          </div>

          <div className="section">
            <h2>Студия</h2>
            <p className="sub">Любой текст выбранным голосом. Результат кешируется на ПК, повтор звучит мгновенно.</p>
            <div className="field">
              <label htmlFor="studio-text">Текст (до 500 знаков)</label>
              <textarea id="studio-text" className="input" rows={3} maxLength={500} value={studio} onChange={(e) => setStudio(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary" style={{ flex: 1 }} disabled={studioBusy || !settings.ttsVoiceId || !studio.trim()} onClick={() => void play(studio)}>{studioBusy ? 'Озвучиваю…' : 'Озвучить'}</button>
              <button className="btn" style={{ flex: 1 }} disabled={studioBusy || !settings.ttsVoiceId} onClick={() => void play(TEST_PHRASE)}>Проверить голос</button>
            </div>
            {studioMsg && <p className="sub" role="status" style={{ marginTop: 8 }}>{studioMsg}</p>}
            {lastClip && <button className="btn block ghost" style={{ marginTop: 8 }} onClick={() => void saveClip()}>Сохранить файл</button>}
          </div>
        </>
      )}

      <div className="section">
        <h2>Подсказки на тренировке</h2>
        <div className="row"><div className="grow">Голосовые подсказки на каждом километре</div><Toggle label="Голосовые подсказки" checked={settings.voiceCues} onChange={(v) => update({ voiceCues: v })} /></div>
        <div className="row"><div className="grow">Голос навигации на улице<div className="sub">Повороты, сход с маршрута, финиш. Включается только тобой.</div></div><Toggle label="Голос навигации" checked={settings.voiceNav} onChange={(v) => update({ voiceNav: v })} /></div>
        <div className="row"><div className="grow">Тренировочные подсказки<div className="sub">Половина дистанции, смена пульсовой зоны (нужен датчик и максимальный пульс), темп (нужна цель).</div></div><Toggle label="Тренировочные подсказки" checked={settings.voiceCoach} onChange={(v) => update({ voiceCoach: v })} /></div>
        {fish && <p className="sub" style={{ marginTop: 8 }}>Перед первой пробежкой проверь на телефоне, что готовая озвучка слышна при погашенном экране. Если нет, вернись на системный голос: он работает в фоне надёжно.</p>}
        <p className="sub" style={{ marginTop: 8 }}>Fish Speech: код под Apache-2.0, веса модели под CC BY-NC-SA 4.0 — только для некоммерческого использования.</p>
      </div>
    </>
  );
}
