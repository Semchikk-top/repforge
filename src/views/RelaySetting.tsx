import { useState } from 'react';
import { buildRelayUrl, getRelayUrl, relayConfigured, setRelayUrl } from '../nearby/config';
import { useToast } from '../ui/Toast';

/**
 * Адрес сигнального релея комнаты «Рядом» и обмена с другом. Показывается в нативном приложении, где адрес можно
 * задать без пересборки. В браузере адрес приходит из сборки и из политики безопасности сервера (CSP), поэтому там поля нет.
 */
export function RelaySetting({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState(getRelayUrl());
  const configured = relayConfigured();

  const save = () => {
    try {
      const saved = setRelayUrl(value);
      setValue(saved);
      toast(saved ? 'Адрес релея сохранён' : 'Адрес релея сброшен');
      onChange();
    } catch (e) { toast(e instanceof Error ? e.message : 'Адрес не подошёл'); }
  };

  return (
    <details className="room-relay" open={!configured}>
      <summary>Адрес релея{configured ? '' : ': не задан'}</summary>
      {!configured && <p className="room-note">Чтобы создать комнату по коду, укажи адрес своего релея (запускается на ПК: папка relay), например wss://relay.имя.ts.net.</p>}
      <div className="field">
        <input className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" autoComplete="off" placeholder="wss://relay.example" aria-label="Адрес релея" value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" style={{ flex: 1 }} onClick={save}>Сохранить</button>
        {getRelayUrl() !== buildRelayUrl() && <button className="btn" style={{ flex: 1 }} onClick={() => { setValue(buildRelayUrl()); setRelayUrl(''); toast('Адрес релея сброшен'); onChange(); }}>Сбросить</button>}
      </div>
    </details>
  );
}
