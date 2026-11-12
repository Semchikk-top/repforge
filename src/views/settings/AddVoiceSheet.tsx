import { useState } from 'react';
import { Sheet } from '../../ui/Sheet';
import { addVoice, type TtsVoice } from '../../tts/api';

const MAX_BYTES = 8 * 1024 * 1024;

function audioDuration(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const a = new Audio();
      const done = (v: number | null) => { URL.revokeObjectURL(url); resolve(v); };
      a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : null);
      a.onerror = () => done(null);
      a.src = url;
    } catch { resolve(null); }
  });
}

// Загрузка своего голоса: образец 10–30 секунд + точный текст образца + согласие. Образец хранится только на ПК.
export function AddVoiceSheet({ onClose, onAdded }: { onClose: () => void; onAdded: (v: TtsVoice) => void }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sec, setSec] = useState<number | null>(null);
  const [transcript, setTranscript] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    setError(null); setSec(null); setFile(null);
    if (!f) return;
    if (f.size > MAX_BYTES) { setError('Файл больше 8 МБ: возьми запись покороче.'); return; }
    setFile(f);
    setSec(await audioDuration(f));
  };

  const durationWarn = sec !== null && (sec < 10 || sec > 30)
    ? (sec < 3 || sec > 60 ? 'Сервер примет образец от 3 до 60 секунд.' : 'Лучше всего работают образцы 10–30 секунд.') : null;
  const ready = !!file && name.trim() !== '' && transcript.trim() !== '' && consent && !busy;

  const submit = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try { onAdded(await addVoice({ name: name.trim(), transcript: transcript.trim(), consent, file })); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить голос'); }
    finally { setBusy(false); }
  };

  return (
    <Sheet title="Новый голос" onClose={onClose}>
      <p className="sub">Образец уходит на твой ПК и лежит там в закрытой папке. В облако он не отправляется и на другие устройства не синхронизируется.</p>
      <div className="field">
        <label htmlFor="voice-name">Название</label>
        <input id="voice-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="voice-file">Запись голоса (WAV, MP3, OGG или FLAC, до 8 МБ)</label>
        <input id="voice-file" className="input" type="file" accept="audio/*,.wav,.mp3,.ogg,.flac" onChange={(e) => void pick(e.target.files?.[0])} />
        {file && <span className="sub">{file.name}{sec !== null ? `, ${Math.round(sec)} с` : ''}</span>}
        {durationWarn && <span className="sub">{durationWarn}</span>}
      </div>
      <div className="field">
        <label htmlFor="voice-text">Что сказано в записи (слово в слово)</label>
        <textarea id="voice-text" className="input" rows={4} maxLength={1000} value={transcript} onChange={(e) => setTranscript(e.target.value)} />
      </div>
      <label className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 4 }} />
        <span className="grow">Это мой голос, либо его владелец дал согласие на клонирование. Чужие и знаменитые голоса без согласия использовать нельзя.</span>
      </label>
      {error && <p className="msg-error" role="alert">{error}</p>}
      <button className="btn primary block" style={{ marginTop: 12 }} disabled={!ready} onClick={() => void submit()}>{busy ? 'Загружаю…' : 'Добавить голос'}</button>
    </Sheet>
  );
}
