import { useEffect, useState } from 'react';
import { useSettings } from '../../state/settings';
import { useToast } from '../../ui/Toast';
import { getTtsConfig, getTtsStatus, saveTtsConfig, type TtsConfig, type TtsStatus } from '../../tts/api';
import { applyConfig } from '../../tts/packs';

const num = (s: string): number | null => { const n = parseFloat(s.trim().replace(',', '.')); return Number.isFinite(n) ? n : null; };

// Подключение Fish Speech: адрес и ключ хранятся на ПК и сюда обратно не возвращаются (видны только «задан» и последние 4 символа).
export function FishConnect() {
  const { settings } = useSettings();
  const toast = useToast();
  const [cfg, setCfg] = useState<TtsConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [format, setFormat] = useState<'mp3' | 'wav'>('mp3');
  const [temp, setTemp] = useState('');
  const [topP, setTopP] = useState('');
  const [rep, setRep] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<TtsStatus | null>(null);

  const fill = (c: TtsConfig) => {
    setCfg(c); setUrl(c.url); setFormat(c.format); setKey('');
    setTemp(String(c.params.temperature)); setTopP(String(c.params.topP)); setRep(String(c.params.repetitionPenalty));
  };
  useEffect(() => { getTtsConfig().then(fill).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Не удалось загрузить настройки')); }, []);

  const save = async () => {
    const t = num(temp), p = num(topP), r = num(rep);
    if (t === null || p === null || r === null) { toast('Проверь параметры синтеза'); return; }
    setBusy(true);
    try {
      const next = await saveTtsConfig({
        url: url.trim(), format, params: { temperature: t, topP: p, repetitionPenalty: r },
        ...(key.trim() ? { apiKey: key.trim() } : {})
      });
      fill(next);
      await applyConfig(next, settings.ttsVoiceId); // параметры или формат сменились: прежняя озвучка устарела
      toast('Сохранено');
    } catch (e) { toast(e instanceof Error ? e.message : 'Не удалось сохранить'); }
    finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true);
    try { setStatus(await getTtsStatus()); } catch (e) { setStatus(null); toast(e instanceof Error ? e.message : 'Не удалось проверить'); }
    finally { setBusy(false); }
  };

  if (err) return <p className="msg-error">{err}</p>;
  if (!cfg) return <p className="sub">Загружаю…</p>;
  return (
    <>
      <div className="field">
        <label htmlFor="fish-url">Адрес Fish Speech на ПК</label>
        <input id="fish-url" className="input" inputMode="url" autoCapitalize="off" value={url} onChange={(e) => setUrl(e.target.value)} />
        <span className="sub">Только этот ПК или частная сеть. Fish должен слушать 127.0.0.1.</span>
      </div>
      <div className="field">
        <label htmlFor="fish-key">API-ключ {cfg.hasKey ? `(задан ${cfg.keyHint})` : '(не задан)'}</label>
        <input id="fish-key" className="input" type="password" autoComplete="off" placeholder={cfg.hasKey ? 'оставь пустым, чтобы не менять' : ''} value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="fish-format">Формат файлов</label>
        <select id="fish-format" className="input" value={format} onChange={(e) => setFormat(e.target.value as 'mp3' | 'wav')}>
          <option value="mp3">MP3 (меньше места)</option>
          <option value="wav">WAV (без конвертации)</option>
        </select>
        {format === 'mp3' && !cfg.ffmpeg && <span className="sub">На ПК не найден ffmpeg: файлы будут в WAV, они крупнее.</span>}
      </div>
      <details style={{ marginTop: 8 }}>
        <summary>Параметры синтеза</summary>
        <div className="field"><label htmlFor="fish-temp">Temperature (0,1–1)</label><input id="fish-temp" className="input" inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} /></div>
        <div className="field"><label htmlFor="fish-topp">Top-p (0,1–1)</label><input id="fish-topp" className="input" inputMode="decimal" value={topP} onChange={(e) => setTopP(e.target.value)} /></div>
        <div className="field"><label htmlFor="fish-rep">Repetition penalty (0,9–2)</label><input id="fish-rep" className="input" inputMode="decimal" value={rep} onChange={(e) => setRep(e.target.value)} /></div>
        <span className="sub">После смены параметров или формата готовую озвучку нужно собрать заново.</span>
      </details>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={() => void save()}>Сохранить</button>
        <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => void check()}>Проверить</button>
      </div>
      {status && <p className="sub" role="status" style={{ marginTop: 8 }}>{status.reachable ? `Fish отвечает${status.latencyMs !== null ? `, ${status.latencyMs} мс` : ''}. Голосов: ${status.voices}.` : status.message}</p>}
    </>
  );
}
