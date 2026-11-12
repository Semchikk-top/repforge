import { useEffect, useState } from 'react';
import { useSettings } from '../../state/settings';
import { useSyncStatus } from '../../sync/useSync';
import { BACKEND_LABEL, getAssistantStatus, resolveBackend, type AssistantStatus, type Backend } from '../../assistant/api';
import { AssistantConnect } from '../AssistantConnect';
import { ConflictsCard } from '../ConflictsCard';
import { SyncSection } from '../SyncSection';
import { FishConnect } from './FishConnect';

function backendStatus(b: Backend, paired: boolean, st: AssistantStatus | null): string {
  if (!paired) return 'Ассистент работает через сервер на ПК: сначала подключи устройство ниже.';
  if (!st) return 'Проверяю доступность…';
  if (b === 'cloud') return st.cloud.configured ? `Облако готово, модель ${st.cloud.model}.` : 'Облако не настроено: нажми «Настроить подключение» и введи API-ключ.';
  if (b === 'local') return st.local.reachable ? `Ollama работает${st.local.model ? `, модель ${st.local.model}` : ', но моделей нет: выполни ollama pull'}.` : 'Ollama не отвечает на ПК. Запусти её или проверь адрес в настройках подключения.';
  if (!st.agent.configured) return 'Агент не подключён: нажми «Настроить подключение» и укажи его адрес.';
  return st.agent.reachable ? `Агент отвечает${st.agent.model ? `, модель ${st.agent.model}` : ''}.` : 'Агент не отвечает: проверь, что он запущен и адрес верный.';
}

export function ServerTab() {
  const { settings, update } = useSettings();
  const sync = useSyncStatus();
  const [astatus, setAstatus] = useState<AssistantStatus | null>(null);
  const [connect, setConnect] = useState(false);
  const refreshStatus = () => { if (sync.configured && !sync.unauthorized) void getAssistantStatus().then(setAstatus); };
  useEffect(refreshStatus, [sync.configured, sync.unauthorized]); // eslint-disable-line react-hooks/exhaustive-deps
  const backend = resolveBackend(settings);

  return (
    <>
      <SyncSection />

      <ConflictsCard />

      <div className="section">
        <h2>Ассистент</h2>
        <div className="seg three" data-i={(['cloud', 'local', 'agent'] as Backend[]).indexOf(backend)} role="group" aria-label="Модель ассистента">
          {(['cloud', 'local', 'agent'] as Backend[]).map((b) => (
            <button key={b} className={backend === b ? 'on' : ''} onClick={() => update({ assistantBackend: b })}>{BACKEND_LABEL[b]}</button>
          ))}
        </div>
        <p className="sub" style={{ marginTop: 8 }}>{backendStatus(backend, !!sync.configured, astatus)}</p>
        <p className="sub" style={{ marginTop: 6 }}>{backend === 'cloud' ? 'В облачном режиме нужные записи из дневника уходят провайдеру модели. Локальные режимы ничего не отправляют наружу.' : 'Локальный режим ничего не отправляет наружу, всё считается на твоём ПК.'}</p>
        <button className="btn block" style={{ marginTop: 12 }} disabled={!sync.configured || sync.unauthorized} onClick={() => setConnect(true)}>Настроить подключение</button>
        {connect && <AssistantConnect initial={backend} onClose={() => setConnect(false)} onChanged={refreshStatus} />}
      </div>

      <div className="section" id="fish-section">
        <h2>Озвучка Fish Speech</h2>
        <p className="sub" style={{ marginBottom: 8 }}>Голоса и подготовка озвучки — во вкладке «Звук». Здесь только подключение к Fish на ПК.</p>
        {sync.configured && !sync.unauthorized ? <FishConnect /> : <p className="sub">Сначала подключи устройство к серверу выше.</p>}
      </div>
    </>
  );
}
