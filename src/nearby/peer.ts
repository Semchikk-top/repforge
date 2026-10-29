// Прямое соединение между телефонами: WebRTC DataChannel без STUN/TURN, только локальная сеть.
import { LIMITS } from './config';
import { channelBinding, computeSas, extractFingerprint, filterRemoteSdp } from './sdp';

export interface PeerHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  /** Канал закрыт или соединение не удалось/оборвалось. */
  onClose(): void;
}
export interface PeerHandle {
  /** Хост: SDP с уже собранными кандидатами (non-trickle). */
  createOffer(): Promise<string>;
  /** Гость: принять offer, вернуть answer. */
  acceptOffer(sdp: string): Promise<string>;
  /** Хост: принять answer. */
  acceptAnswer(sdp: string): Promise<void>;
  /** Код сверки из отпечатков обоих SDP; можно вызывать после обмена. */
  sas(): Promise<string>;
  /** Отпечатки DTLS обеих сторон одной строкой: к ним привязываются подписи, чтобы их нельзя было переложить на другой канал. */
  binding(): string;
  send(text: string): boolean;
  close(): void;
}
export interface PeerOptions {
  /** STUN/TURN для друзей на расстоянии. Для комнаты «Рядом» пусто: только локальная сеть. */
  iceServers?: RTCIceServer[];
  /** Принимать публичные адреса кандидатов (нужно вместе с iceServers). */
  allowPublic?: boolean;
}
export type PeerFactory = (role: 'host' | 'guest', h: PeerHandlers, opts?: PeerOptions) => PeerHandle;

export const createPeerLink: PeerFactory = (role, h, opts) => {
  // Никаких iceServers: внешних запросов нет, кандидаты только из локальной сети
  const pc = new RTCPeerConnection({ iceServers: opts?.iceServers ?? [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  let dc: RTCDataChannel | null = null;
  let closed = false;
  let graceTimer: number | undefined;

  const notifyClosed = () => { if (!closed) { closed = true; h.onClose(); } };

  const bind = (ch: RTCDataChannel) => {
    dc = ch;
    ch.onopen = () => { if (!closed) h.onOpen(); };
    ch.onmessage = (e) => { if (!closed && typeof e.data === 'string') h.onMessage(e.data); };
    ch.onclose = notifyClosed;
  };
  // Хост создаёт канал сразу (по действию человека), гость получает его через ondatachannel
  if (role === 'host') bind(pc.createDataChannel('room', { ordered: true }));
  else pc.ondatachannel = (e) => bind(e.channel);

  pc.onconnectionstatechange = () => {
    if (closed) return;
    window.clearTimeout(graceTimer);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') notifyClosed();
    // «disconnected» бывает кратким: даём связи вернуться
    else if (pc.connectionState === 'disconnected') graceTimer = window.setTimeout(() => { if (pc.connectionState === 'disconnected') notifyClosed(); }, LIMITS.disconnectedGraceMs);
  };

  const gathered = () => new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => { window.clearTimeout(t); pc.removeEventListener('icegatheringstatechange', onChange); resolve(); };
    const onChange = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = window.setTimeout(done, LIMITS.iceGatherMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });

  const checkedRemote = (sdp: string) => {
    if (typeof sdp !== 'string' || !extractFingerprint(sdp)) throw new Error('В SDP нет отпечатка');
    return opts?.allowPublic ? sdp : filterRemoteSdp(sdp);
  };
  const localSdp = () => {
    const s = pc.localDescription?.sdp;
    if (!s) throw new Error('Нет локального SDP');
    return s;
  };

  return {
    async createOffer() {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered();
      return localSdp();
    },
    async acceptOffer(sdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp: checkedRemote(sdp) });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered();
      return localSdp();
    },
    async acceptAnswer(sdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp: checkedRemote(sdp) });
    },
    async sas() {
      const remote = pc.remoteDescription?.sdp;
      if (!remote) throw new Error('Нет удалённого SDP');
      return computeSas(localSdp(), remote);
    },
    binding() {
      const remote = pc.remoteDescription?.sdp;
      if (!remote) throw new Error('Нет удалённого SDP');
      return channelBinding(localSdp(), remote);
    },
    send(text) {
      if (!dc || dc.readyState !== 'open') return false;
      try { dc.send(text); return true; } catch { return false; }
    },
    close() {
      closed = true;
      window.clearTimeout(graceTimer);
      try { dc?.close(); } catch { /* уже закрыт */ }
      try { pc.close(); } catch { /* уже закрыт */ }
    }
  };
};
