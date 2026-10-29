import { getDeviceId } from '../db/repo';
import { apiFetch, deviceLabel, pairWithCode } from './sync';

export interface InviteCandidate {
  url: string;
  kind: 'configured' | 'current' | 'tailscale' | 'lan';
  secure: boolean;
  reachable: boolean;
  link: string;
  qr: string | null;
}
export interface Invite { code: string; expiresAt: number; candidates: InviteCandidate[]; best: number | null }

export const KIND_LABEL: Record<InviteCandidate['kind'], string> = {
  configured: 'Заданный адрес',
  current: 'Этот адрес',
  tailscale: 'Tailscale (HTTPS)',
  lan: 'Локальная сеть (HTTP)'
};

// QR приходит как SVG-текст; в <img> скрипты не выполняются, поэтому это безопасно
export const qrDataUrl = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

export async function createInvite(): Promise<Invite> {
  const r = await apiFetch('/api/pairing/invite', { method: 'POST', body: '{}' });
  if (!r.ok) throw new Error(r.status === 401 ? 'Устройство отключено от сервера' : `Ошибка сервера (${r.status})`);
  return (await r.json()) as Invite;
}

export interface PendingRequest { id: string; name: string; pin: string; ip?: string; age: number }

export async function fetchPending(): Promise<PendingRequest[]> {
  try {
    const r = await apiFetch('/api/pairing/pending');
    return r.ok ? ((await r.json()) as PendingRequest[]) : [];
  } catch {
    return [];
  }
}

export async function decidePending(id: string, approve: boolean): Promise<boolean> {
  try {
    return (await apiFetch(`/api/pairing/pending/${id}`, { method: 'POST', body: JSON.stringify({ approve }) })).ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Телефон просит подключиться: показывает PIN, ждёт подтверждения на ПК и сам завершает сопряжение.
export async function requestPairing(opts: { signal: AbortSignal; onPin: (pin: string) => void }): Promise<void> {
  const deviceId = await getDeviceId();
  let res: Response;
  try {
    res = await fetch('/api/pairing/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, name: deviceLabel() }),
      signal: opts.signal
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error('Сервер недоступен. Открой приложение по адресу сервера на ПК.');
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail;
    throw new Error(typeof detail === 'string' ? detail : `Ошибка сервера (${res.status})`);
  }
  const { requestId, pin, expiresIn } = (await res.json()) as { requestId: string; pin: string; expiresIn: number };
  opts.onPin(pin);

  const deadline = Date.now() + (expiresIn + 5) * 1000;
  try {
    while (Date.now() < deadline) {
      await sleep(1500);
      if (opts.signal.aborted) throw new DOMException('Отменено', 'AbortError');
      const r = await fetch(`/api/pairing/request/${requestId}`, { signal: opts.signal });
      const body = (await r.json()) as { status: string; code?: string };
      if (body.status === 'approved' && body.code) return await pairWithCode(body.code);
      if (body.status === 'denied') throw new Error('ПК отклонил запрос.');
      if (body.status === 'expired' || body.status === 'done') throw new Error('Время ожидания истекло. Попробуй ещё раз.');
    }
    throw new Error('Время ожидания истекло. Попробуй ещё раз.');
  } catch (e) {
    if ((e as Error).name === 'AbortError') void fetch(`/api/pairing/request/${requestId}`, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}
