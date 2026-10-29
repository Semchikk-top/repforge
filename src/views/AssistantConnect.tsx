import { useEffect, useState } from 'react';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import {
  getConnectionConfig, saveConnectionConfig, testConnection,
  type Backend, type ConnectionConfig, type ConnectionPatch, type TestResult
} from '../assistant/api';

const ANTHROPIC_URL = 'https://api.anthropic.com';
const OPENAI_URL = 'https://api.openai.com/v1';
const OLLAMA_URL = 'http://127.0.0.1:11434/v1';

const TABS: { id: Backend; label: string }[] = [
  { id: 'cloud', label: 'Облако' },
  { id: 'local', label: 'Ollama' },
  { id: 'agent', label: 'Агент' }
];

// Экран подключения ассистента: облако (API-ключ), Ollama и локальный агент (например, на Omarchy).
// Ключи уходят на сервер ПК и обратно не возвращаются: здесь видны только «задан» и последние 4 символа.
export function AssistantConnect({ initial, onClose, onChanged }: { initial: Backend; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Backend>(initial);
  const [cfg, setCfg] = useState<ConnectionConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<Backend, TestResult | null>>({ cloud: null, local: null, agent: null });

  // поля форм; секреты пустые, пока человек не введёт новое значение
  const [provider, setProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [cloudUrl, setCloudUrl] = useState(ANTHROPIC_URL);
  const [apiKey, setApiKey] = useState('');
  const [cloudModel, setCloudModel] = useState('');
  const [localUrl, setLocalUrl] = useState(OLLAMA_URL);
  const [localModel, setLocalModel] = useState('');
  const [agentUrl, setAgentUrl] = useState('');
  const [agentToken, setAgentToken] = useState('');
  const [agentModel, setAgentModel] = useState('');

  const fill = (c: ConnectionConfig) => {
    setCfg(c);
    setProvider(c.cloud.provider);
    setCloudUrl(c.cloud.baseUrl || (c.cloud.provider === 'anthropic' ? ANTHROPIC_URL : OPENAI_URL));
    setCloudModel(c.cloud.model);
    setLocalUrl(c.local.url || OLLAMA_URL);
    setLocalModel(c.local.model);
    setAgentUrl(c.agent.url);
    setAgentModel(c.agent.model);
    setApiKey('');
    setAgentToken('');
  };

  useEffect(() => { getConnectionConfig().then(fill).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить настройки')); }, []);

  const changeProvider = (p: 'anthropic' | 'openai') => {
    setProvider(p);
    setCloudUrl(p === 'anthropic' ? ANTHROPIC_URL : OPENAI_URL);
    setCloudModel(p === 'anthropic' ? 'claude-sonnet-5-5' : '');
    setResult((r) => ({ ...r, cloud: null }));
  };

  const run = async (patch: ConnectionPatch, check: Backend | null, okMessage: string) => {
    setBusy(true);
    try {
      fill(await saveConnectionConfig(patch));
      onChanged();
      if (check) {
        const res = await testConnection(check);
        setResult((r) => ({ ...r, [check]: res }));
        toast(res.ok ? okMessage : 'Сохранено, но подключиться не удалось');
      } else {
        toast(okMessage);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally { setBusy(false); }
  };

  const saveCloud = () => run({ cloud: { provider, baseUrl: cloudUrl.trim(), model: cloudModel.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } }, 'cloud', 'Облако подключено');
  const removeKey = () => { if (confirm('Удалить сохранённый API-ключ с сервера?')) void run({ cloud: { apiKey: '' } }, null, 'Ключ удалён'); };
  const saveLocal = () => run({ local: { url: localUrl.trim(), model: localModel.trim() } }, 'local', 'Ollama подключена');
  const saveAgent = () => run({ agent: { url: agentUrl.trim(), model: agentModel.trim(), ...(agentToken.trim() ? { token: agentToken.trim() } : {}) } }, 'agent', 'Агент подключён');
  const removeToken = () => { if (confirm('Удалить сохранённый токен агента?')) void run({ agent: { token: '' } }, null, 'Токен удалён'); };

  const Status = ({ r }: { r: TestResult | null }) => r ? (
    <div className={'conn-status ' + (r.ok ? 'ok' : 'bad')} role="status"><i />{r.ok ? `Подключено${r.models.length ? `, моделей: ${r.models.length}` : ''}` : r.message || 'Не удалось подключиться'}</div>
  ) : null;

  const Models = ({ r, set }: { r: TestResult | null; set: (m: string) => void }) => r?.ok && r.models.length ? (
    <div className="conn-models" aria-label="Доступные модели">{r.models.slice(0, 12).map((m) => <button key={m} type="button" className="chip" onClick={() => set(m)}>{m}</button>)}</div>
  ) : null;

  return (
    <Sheet title="Подключение ассистента" onClose={onClose}>
      <div className="seg three" data-i={TABS.findIndex((t) => t.id === tab)} role="tablist" aria-label="Способ подключения">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>

      {loadError && <p className="msg-error" style={{ marginTop: 12 }}>{loadError}</p>}
      {!cfg && !loadError && <p className="sub" style={{ marginTop: 12 }}>Загружаю…</p>}

      {cfg && tab === 'cloud' && (
        <div style={{ marginTop: 14 }}>
          <p className="conn-note">Модель в облаке по API-ключу. Ключ хранится только на твоём ПК и в приложение обратно не возвращается. Нужные записи дневника уходят провайдеру вместе с вопросом.</p>
          <div className="field">
            <label htmlFor="c-provider">Провайдер</label>
            <select id="c-provider" className="input" value={provider} onChange={(e) => changeProvider(e.target.value as 'anthropic' | 'openai')}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI-совместимый (OpenAI, OpenRouter…)</option>
            </select>
          </div>
          {provider === 'openai' && (
            <div className="field">
              <label htmlFor="c-url">Адрес API (https)</label>
              <input id="c-url" className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label htmlFor="c-key">API-ключ</label>
            <input id="c-key" className="input" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={cfg.cloud.hasKey ? `Сохранён ${cfg.cloud.keyHint} (новый заменит)` : provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} />
            {cfg.cloud.keySource === 'env' && <span className="sub">Сейчас используется ключ из файла .env на ПК. Ключ, введённый здесь, будет главнее.</span>}
          </div>
          <div className="field">
            <label htmlFor="c-model">Модель</label>
            <input id="c-model" className="input" autoCapitalize="none" autoCorrect="off" value={cloudModel} onChange={(e) => setCloudModel(e.target.value)} placeholder={provider === 'anthropic' ? 'claude-sonnet-5-5' : 'например, gpt-4o-mini'} />
          </div>
          <Models r={result.cloud} set={setCloudModel} />
          <Status r={result.cloud} />
          <div className="conn-actions">
            <button className="btn primary" disabled={busy || (!apiKey.trim() && !cfg.cloud.hasKey)} onClick={() => void saveCloud()}>{busy ? 'Проверяю…' : 'Сохранить и проверить'}</button>
            {cfg.cloud.keySource === 'app' && <button className="btn danger" disabled={busy} onClick={removeKey}>Удалить ключ</button>}
          </div>
        </div>
      )}

      {cfg && tab === 'local' && (
        <div style={{ marginTop: 14 }}>
          <p className="conn-note">Ollama на ПК с сервером. Всё считается у тебя, ничего не уходит наружу. Если модели ещё нет, выполни на ПК <code>ollama pull qwen2.5:7b</code>.</p>
          <div className="field">
            <label htmlFor="l-url">Адрес Ollama</label>
            <input id="l-url" className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="l-model">Модель</label>
            <input id="l-model" className="input" autoCapitalize="none" autoCorrect="off" value={localModel} onChange={(e) => setLocalModel(e.target.value)} placeholder="пусто: взять первую установленную" />
          </div>
          <Models r={result.local} set={setLocalModel} />
          <Status r={result.local} />
          <div className="conn-actions">
            <button className="btn primary" disabled={busy || !localUrl.trim()} onClick={() => void saveLocal()}>{busy ? 'Проверяю…' : 'Сохранить и проверить'}</button>
          </div>
        </div>
      )}

      {cfg && tab === 'agent' && (
        <div style={{ marginTop: 14 }}>
          <p className="conn-note">Локальный агент на ПК (например, на Omarchy): любой сервис с OpenAI-совместимым API — <code>/v1/chat/completions</code> и <code>/v1/models</code>. Подойдут llama.cpp, LM Studio, vLLM и свой агент. Адрес должен вести на этот ПК или в домашнюю сеть.</p>
          <div className="field">
            <label htmlFor="a-url">Адрес агента</label>
            <input id="a-url" className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" value={agentUrl} onChange={(e) => setAgentUrl(e.target.value)} placeholder="http://127.0.0.1:8080/v1" />
          </div>
          <div className="field">
            <label htmlFor="a-token">Токен (если агент его требует)</label>
            <input id="a-token" className="input" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={agentToken} onChange={(e) => setAgentToken(e.target.value)}
              placeholder={cfg.agent.hasToken ? `Сохранён ${cfg.agent.tokenHint} (новый заменит)` : 'необязательно'} />
          </div>
          <div className="field">
            <label htmlFor="a-model">Модель</label>
            <input id="a-model" className="input" autoCapitalize="none" autoCorrect="off" value={agentModel} onChange={(e) => setAgentModel(e.target.value)} placeholder="пусто: взять первую из списка агента" />
          </div>
          <Models r={result.agent} set={setAgentModel} />
          <Status r={result.agent} />
          <div className="conn-actions">
            <button className="btn primary" disabled={busy || !agentUrl.trim()} onClick={() => void saveAgent()}>{busy ? 'Проверяю…' : 'Сохранить и проверить'}</button>
            {cfg.agent.hasToken && <button className="btn danger" disabled={busy} onClick={removeToken}>Удалить токен</button>}
          </div>
        </div>
      )}
    </Sheet>
  );
}
