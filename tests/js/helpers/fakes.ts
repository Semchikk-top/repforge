// Подделки для проверки комнаты без браузера: настоящий RoomStore релея + пара «телефонов» в памяти.
// @ts-expect-error JS-модуль релея без типов
import { RoomStore } from '../../../relay/src/rooms.js';
import { channelBinding, computeSas } from '../../../src/nearby/sdp';
import { RoomManager } from '../../../src/nearby/room';
import type { PeerFactory, PeerHandle, PeerHandlers } from '../../../src/nearby/peer';
import type { SignalingFactory } from '../../../src/nearby/signaling';

const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

export class FakeNet {
  store = new RoomStore({ ttlMs: 10 * 60_000, hostGraceMs: 15_000 });
  peers: FakePeer[] = [];
  byId = new Map<string, FakePeer>();
  /** 'ok' — канал откроется; 'never' — ICE не пробился. */
  mode: 'ok' | 'never' = 'ok';
  /** MITM: хост видит чужой отпечаток вместо отпечатка гостя. */
  tamper = false;
  /** Молчание в канале: сообщения теряются (но канал «открыт»). */
  muted = false;
  /** Сколько первых сообщений гостя потерять (канал у хоста ещё не готов). */
  dropFirstFromGuest = 0;
  nextId = 1;

  signaling: SignalingFactory = (_url, h) => {
    let closed = false;
    const conn = {
      ip: '10.0.0.1', room: null as unknown, role: null as unknown,
      send: (o: unknown) => queueMicrotask(() => { if (!closed) h.onMessage(JSON.parse(JSON.stringify(o))); }),
      close: () => { if (closed) return; closed = true; queueMicrotask(() => h.onClose(false)); }
    };
    queueMicrotask(() => { if (!closed) h.onOpen(); });
    return {
      send: (m) => {
        if (closed) return;
        const copy = JSON.parse(JSON.stringify(m)); // как по сети: отправленное успеет дойти, даже если сразу закрыли
        queueMicrotask(() => this.store.handle(conn, copy));
      },
      close: () => { if (closed) return; closed = true; this.store.disconnect(conn); }
    };
  };

  peer: PeerFactory = (role, h) => {
    const p = new FakePeer(this, role, h);
    this.peers.push(p);
    return p;
  };

  /** Оборвать все каналы (экран погас, ушли из зоны хотспота). */
  cutAll() { for (const p of this.peers) p.drop(); }
  host() { return this.peers.find((p) => p.role === 'host')!; }
  guest() { return this.peers.find((p) => p.role === 'guest')!; }
}

export class FakePeer implements PeerHandle {
  id: string;
  fp = hex(32);
  localSdp = '';
  remoteSdp = '';
  linked: FakePeer | null = null;
  closed = false;
  open = false;
  sent: string[] = [];
  constructor(private net: FakeNet, public role: 'host' | 'guest', private h: PeerHandlers) { this.id = `p${net.nextId++}`; }

  private sdp(fp: string) { return `v=0\r\na=fingerprint:sha-256 ${fp}\r\na=x-id:${this.id}\r\n`; }

  async createOffer() { this.net.byId.set(this.id, this); this.localSdp = this.sdp(this.fp); return this.localSdp; }
  async acceptOffer(sdp: string) {
    const id = /a=x-id:(\S+)/.exec(sdp)![1];
    const host = this.net.byId.get(id)!;
    this.linked = host; host.linked = this;
    this.remoteSdp = sdp; this.localSdp = this.sdp(this.fp);
    return this.localSdp;
  }
  async acceptAnswer(sdp: string) {
    this.remoteSdp = this.net.tamper ? this.sdp(hex(32)) : sdp;
    if (this.net.mode === 'ok') queueMicrotask(() => { this.setOpen(); this.linked?.setOpen(); });
  }
  private setOpen() { if (this.closed || this.open) return; this.open = true; this.h.onOpen(); }
  async sas() { return computeSas(this.localSdp, this.remoteSdp); }
  binding() { return channelBinding(this.localSdp, this.remoteSdp); }
  send(text: string) {
    if (this.closed || !this.open) return false;
    this.sent.push(text);
    if (this.role === 'guest' && this.net.dropFirstFromGuest > 0) { this.net.dropFirstFromGuest--; return true; }
    if (!this.net.muted) { const other = this.linked; queueMicrotask(() => { if (other && !other.closed) other.deliver(text); }); }
    return true;
  }
  /** Доставить сообщение так, будто оно пришло от друга (в том числе поддельное). */
  deliver(text: string) { if (!this.closed) this.h.onMessage(text); }
  drop() { if (!this.closed) this.h.onClose(); }
  close() {
    if (this.closed) return;
    this.closed = true;
    const other = this.linked;
    queueMicrotask(() => { if (other && !other.closed) other.h.onClose(); });
  }
}

export function makePair(opts: { relayUrl?: string; now?: () => number } = {}) {
  const net = new FakeNet();
  const make = () => new RoomManager({ signaling: net.signaling, peer: net.peer, relayUrl: opts.relayUrl ?? 'wss://relay.test', now: opts.now });
  return { net, host: make(), guest: make() };
}

/** Дать выполниться цепочке промисов и микрозадач. */
export const flush = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/** Ждать, пока условие выполнится (реальные таймеры). */
export async function until(cond: () => boolean, ms = 1000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('условие не наступило');
    await new Promise((r) => setTimeout(r, 1));
  }
}
