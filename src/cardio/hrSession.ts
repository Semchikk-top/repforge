// Подключение к пульсометру с переподключением. Сам Bluetooth скрыт за `HeartRateApi`, поэтому логика
// проверяется тестами с поддельным датчиком.
import type { HeartRateApi, HeartRateLink } from '../platform/types';
import type { HrSample } from './hrParse';

export type HrState = 'connecting' | 'live' | 'reconnecting' | 'failed' | 'stopped';

export interface HrSessionOptions {
  /** паузы перед попытками переподключения; после последней попытки состояние «failed» */
  retryDelaysMs?: number[];
  /** если столько мс нет ни одного отсчёта, связь считается потерянной */
  staleMs?: number;
}

export const DEFAULT_RETRY_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000];
export const DEFAULT_STALE_MS = 20_000;

export interface HrSession { stop(): Promise<void> }

export function startHrSession(
  api: HeartRateApi,
  deviceId: string,
  on: { sample(s: HrSample): void; state(s: HrState, attempt: number): void },
  opts: HrSessionOptions = {}
): HrSession {
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  let stopped = false;
  let link: HeartRateLink | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0; // отличает события старого подключения от нового

  const emit = (s: HrState) => { if (!stopped) on.state(s, attempt); };

  const dropLink = async () => {
    clearTimeout(staleTimer);
    const l = link; link = null;
    if (l) { try { await l.close(); } catch { /* уже отключён */ } }
  };

  const armStale = (gen: number) => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => { if (gen === generation) void lost(gen); }, staleMs);
  };

  const lost = async (gen: number) => {
    if (stopped || gen !== generation) return;
    generation++; // всё, что придёт от этого подключения дальше, игнорируем
    await dropLink();
    scheduleRetry();
  };

  const scheduleRetry = () => {
    if (stopped) return;
    if (attempt >= delays.length) { emit('failed'); return; }
    const wait = delays[attempt++];
    emit('reconnecting');
    retryTimer = setTimeout(() => void connect(), wait);
  };

  const connect = async () => {
    if (stopped) return;
    const gen = ++generation;
    try {
      const l = await api.connect(deviceId, {
        onSample: (s) => {
          if (stopped || gen !== generation) return;
          if (attempt !== 0) attempt = 0;
          armStale(gen);
          on.sample(s);
        },
        onLost: () => void lost(gen)
      });
      if (stopped || gen !== generation) { try { await l.close(); } catch { /* ignore */ } return; }
      link = l;
      armStale(gen);
      emit('live');
    } catch {
      if (stopped || gen !== generation) return;
      generation++;
      scheduleRetry();
    }
  };

  emit('connecting');
  void connect();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      generation++;
      clearTimeout(retryTimer);
      await dropLink();
      on.state('stopped', attempt);
    }
  };
}
