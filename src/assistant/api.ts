import { apiFetch } from '../sync/sync';
import type { MuscleGroup, Settings } from '../domain/types';

export type Backend = 'cloud' | 'local' | 'agent';

export const BACKEND_LABEL: Record<Backend, string> = { cloud: 'Облако', local: 'Ollama', agent: 'Агент' };

export interface ProposalExercise { name: string; sets: number; reps: number; weight?: number; muscle?: MuscleGroup }
export interface Proposal { date: string; title: string; exercises: ProposalExercise[] }
export interface ProposalState extends Proposal { id: string; workoutId?: string }

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  proposals?: ProposalState[];
  notices?: string[];
  error?: string;
  stopped?: boolean;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; label: string }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'notice'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export function resolveBackend(s: Pick<Settings, 'assistantBackend'>): Backend {
  if (s.assistantBackend) return s.assistantBackend;
  return /Android|iPhone|iPad/i.test(navigator.userAgent) ? 'cloud' : 'local';
}

export interface AssistantStatus {
  cloud: { configured: boolean; model: string };
  local: { reachable: boolean; model: string };
  agent: { configured: boolean; reachable: boolean; model: string };
}

// Настройки подключения без секретов: сервер отдаёт только «задан ли ключ» и последние 4 символа
export interface ConnectionConfig {
  cloud: { provider: 'anthropic' | 'openai'; baseUrl: string; model: string; hasKey: boolean; keyHint: string; keySource: 'app' | 'env' | 'none' };
  local: { url: string; model: string };
  agent: { url: string; model: string; hasToken: boolean; tokenHint: string };
}
export interface ConnectionPatch {
  cloud?: { provider?: 'anthropic' | 'openai'; baseUrl?: string; apiKey?: string; model?: string };
  local?: { url?: string; model?: string };
  agent?: { url?: string; token?: string; model?: string };
}
export interface TestResult { ok: boolean; models: string[]; message: string }

async function errorText(r: Response): Promise<string> {
  const detail = (await r.json().catch(() => null))?.detail;
  if (r.status === 401) return 'Устройство отключено от сервера. Подключи его заново.';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return 'Проверь введённые значения';
  return `Ошибка сервера (${r.status})`;
}

export async function getConnectionConfig(): Promise<ConnectionConfig> {
  const r = await apiFetch('/api/assistant/config');
  if (!r.ok) throw new Error(await errorText(r));
  return (await r.json()) as ConnectionConfig;
}

export async function saveConnectionConfig(patch: ConnectionPatch): Promise<ConnectionConfig> {
  const r = await apiFetch('/api/assistant/config', { method: 'PUT', body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(await errorText(r));
  return (await r.json()) as ConnectionConfig;
}

export async function testConnection(backend: Backend): Promise<TestResult> {
  const r = await apiFetch('/api/assistant/test', { method: 'POST', body: JSON.stringify({ backend }) });
  if (!r.ok) throw new Error(await errorText(r));
  return (await r.json()) as TestResult;
}

export async function getAssistantStatus(): Promise<AssistantStatus | null> {
  try {
    const r = await apiFetch('/api/assistant/status');
    return r.ok ? ((await r.json()) as AssistantStatus) : null;
  } catch {
    return null;
  }
}

// Ответ приходит потоком SSE: строки «data: {json}», события разделены пустой строкой
export async function* streamChat(
  backend: Backend,
  messages: { role: string; content: string }[],
  today: string,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  let res: Response;
  try {
    res = await apiFetch('/api/assistant/chat', { method: 'POST', body: JSON.stringify({ backend, messages, today }), signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(e instanceof Error && e.message === 'Устройство не подключено' ? e.message : 'Нет связи с сервером на ПК.');
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail;
    throw new Error(res.status === 401 ? 'Устройство отключено от сервера. Подключи его заново в настройках.' : typeof detail === 'string' ? detail : `Ошибка сервера (${res.status})`);
  }
  if (!res.body) throw new Error('Сервер не отдал поток ответа');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          yield JSON.parse(line.slice(5).trim()) as StreamEvent;
        } catch { /* битый кусок пропускаем */ }
      }
    }
  }
}
