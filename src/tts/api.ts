// Клиент серверной озвучки. Приложение ходит только на свой сервер workapp: адрес и ключ Fish остаются на ПК.
import { apiFetch } from '../sync/sync';
import type { SynthParams } from './cache';

export interface TtsConfig {
  url: string; hasKey: boolean; keyHint: string; keySource: 'app' | 'env' | 'none';
  format: 'mp3' | 'wav'; params: SynthParams; ffmpeg: boolean;
}
export interface TtsConfigPatch { url?: string; apiKey?: string; format?: 'mp3' | 'wav'; params?: Partial<SynthParams> }
export interface TtsStatus {
  reachable: boolean; latencyMs: number | null; message: string; voices: number; ffmpeg: boolean; format: 'mp3' | 'wav';
  cache: { files: number; bytes: number; limitBytes: number };
}
export interface TtsVoice { id: string; name: string; createdAt: number; bytes: number; durationSec: number | null; ext: string }
export interface SynthResult { hash: string; ext: string; bytes: number; duration: number | null; cached: boolean }

export type PackEvent =
  | { type: 'start'; total: number }
  | ({ type: 'item'; key: string } & SynthResult)
  | { type: 'error'; key: string; message: string }
  | { type: 'fatal'; message: string }
  | { type: 'done'; ok: number; failed: number };

export class TtsApiError extends Error {}

async function fail(r: Response): Promise<never> {
  const detail = (await r.json().catch(() => null))?.detail;
  if (r.status === 401) throw new TtsApiError('Устройство отключено от сервера. Подключи его заново.');
  if (typeof detail === 'string') throw new TtsApiError(detail);
  if (Array.isArray(detail)) throw new TtsApiError('Проверь введённые значения');
  throw new TtsApiError(`Ошибка сервера (${r.status})`);
}
async function json<T>(r: Response): Promise<T> { if (!r.ok) await fail(r); return (await r.json()) as T; }

export const getTtsConfig = async (): Promise<TtsConfig> => json(await apiFetch('/api/tts/config'));
export const saveTtsConfig = async (p: TtsConfigPatch): Promise<TtsConfig> => json(await apiFetch('/api/tts/config', { method: 'PUT', body: JSON.stringify(p) }));
export const getTtsStatus = async (): Promise<TtsStatus> => json(await apiFetch('/api/tts/status'));
export const listVoices = async (): Promise<TtsVoice[]> => (await json<{ voices: TtsVoice[] }>(await apiFetch('/api/tts/voices'))).voices;
export const deleteVoice = async (id: string): Promise<void> => { const r = await apiFetch(`/api/tts/voices/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (!r.ok) await fail(r); };
export const clearServerCache = async (): Promise<number> => (await json<{ removed: number }>(await apiFetch('/api/tts/cache', { method: 'DELETE' }))).removed;
export const synthesize = async (voiceId: string, text: string): Promise<SynthResult> =>
  json(await apiFetch('/api/tts/synthesize', { method: 'POST', body: JSON.stringify({ voiceId, text }) }));

export async function fetchAudio(hash: string): Promise<Blob> {
  const r = await apiFetch(`/api/tts/audio/${hash}`);
  if (!r.ok) await fail(r);
  return await r.blob();
}

export const toBase64 = (buf: ArrayBuffer): string => {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function addVoice(v: { name: string; transcript: string; consent: boolean; file: Blob }): Promise<TtsVoice> {
  const audio = toBase64(await v.file.arrayBuffer());
  return json(await apiFetch('/api/tts/voices', { method: 'POST', body: JSON.stringify({ name: v.name, transcript: v.transcript, consent: v.consent, audio }) }));
}

/** Разбор потока событий сборки пака (SSE). Прерывается через signal. */
export async function* streamPack(voiceId: string, phrases: { key: string; text: string }[], signal?: AbortSignal): AsyncGenerator<PackEvent> {
  const r = await apiFetch('/api/tts/pack', { method: 'POST', body: JSON.stringify({ voiceId, phrases }), signal });
  if (!r.ok) await fail(r);
  if (!r.body) throw new TtsApiError('Сервер не прислал поток');
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (chunk.startsWith('data: ')) { try { yield JSON.parse(chunk.slice(6)) as PackEvent; } catch { /* битое событие пропускаем */ } }
      }
    }
  } finally { try { await reader.cancel(); } catch { /* уже закрыт */ } }
}
