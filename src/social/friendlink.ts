// Живое соединение с другом: добавление нового друга (код → сверка → подтверждение обеими сторонами)
// и обмен снимками рейтинга с уже добавленным. Права и доступ к дневнику не передаются: только подписанные агрегаты.
// Транспорт тот же, что у комнаты «Рядом»: релей для сигналинга и прямой канал WebRTC.
import { APP_VERSION, LIMITS, PROTO_VERSION } from '../nearby/config';
import { normalizeCode } from '../nearby/code';
import type { PeerFactory, PeerHandle, PeerOptions } from '../nearby/peer';
import type { CloseReason } from '../nearby/room';
import type { SignalingFactory, SignalingHandle, RelayMsg } from '../nearby/signaling';
import { Reassembler, splitMessage } from './chunking';
import { profileIdFor, verifyText } from './crypto';
import { authText, encodeFriendWire, FRIEND_PROTO, parseFriendWire, type Card, type FriendWire } from './friendwire';
import { checkSnapshot, randomNonce, type LeaderboardSnapshot } from './snapshot';
import type { Friend } from './types';

export type FriendReason = CloseReason | 'declined' | 'blocked' | 'key-changed' | 'bad-auth' | 'self' | 'no-profile' | 'sync-failed';

export const FRIEND_REASON_TEXT: Record<FriendReason, string> = {
  'no-relay': 'В этой сборке не задан адрес релея, поэтому добавить друга по коду нельзя. Можно обменяться файлом снимка.',
  'offline': 'Нет интернета для подключения. Код работает только при сети; обмен файлом снимка остаётся доступным.',
  'bad-code': 'Неверный или просроченный код.',
  'room-full': 'К этому коду уже подключился другой человек.',
  'rate-limit': 'Слишком много попыток. Подождите минуту.',
  'version': 'Обновите приложение: у друга другая версия.',
  'expired': 'Код истёк. Создайте приглашение заново.',
  'ice-failed': 'Не удалось соединиться напрямую. Без TURN-сервера это работает только в одной сети (хотспот, домашний Wi-Fi). Остаётся обмен файлом снимка.',
  'rejected': 'Друг отказался.',
  'peer-left': 'Друг вышел до завершения.',
  'lost': 'Связь потеряна.',
  'timeout': 'Время ожидания вышло.',
  'unsupported': 'Этот браузер не умеет прямое соединение между телефонами.',
  'generic': 'Что-то пошло не так. Попробуйте ещё раз.',
  'declined': 'Друг отклонил добавление.',
  'blocked': 'Этот человек в вашем списке блокировок.',
  'key-changed': 'Ключ этого друга изменился. Возможна подмена: сверьте отпечаток лично и только потом доверяйте.',
  'bad-auth': 'Не удалось подтвердить личность друга.',
  'self': 'Это ваше собственное приглашение.',
  'no-profile': 'Сначала создайте профиль.',
  'sync-failed': 'Обмен снимками не завершился.'
};

export type FriendPhase = 'idle' | 'creating' | 'waiting' | 'joining' | 'connecting' | 'verifying' | 'confirm' | 'syncing' | 'done' | 'closed';

export interface FriendLinkState {
  phase: FriendPhase;
  role: 'host' | 'guest' | null;
  code: string | null;
  expiresAt: number | null;
  peer: Card | null;
  sas: string | null;
  /** Друг уже был добавлен: подтверждение не нужно, идёт только обмен. */
  known: boolean;
  iConfirmed: boolean;
  result: { added: boolean; received: number; rejected: number } | null;
  reason: FriendReason | null;
}

export interface FriendIdentity { profileId: string; publicKey: string; displayName: string; sign(text: string): Promise<string> }

export interface FriendStoreApi {
  identity(): Promise<FriendIdentity | null>;
  getFriend(id: string): Promise<Friend | undefined>;
  addFriend(card: Card): Promise<void>;
  touchFriend(card: Card): Promise<void>;
  mySnapshots(): Promise<LeaderboardSnapshot[]>;
  saveSnapshots(profileId: string, snaps: LeaderboardSnapshot[]): Promise<number>;
}

export interface FriendLinkDeps {
  signaling: SignalingFactory;
  peer: PeerFactory;
  peerOptions?: PeerOptions;
  relayUrl: string;
  store: FriendStoreApi;
  now: () => number;
}

const initial = (): FriendLinkState => ({ phase: 'idle', role: null, code: null, expiresAt: null, peer: null, sas: null, known: false, iConfirmed: false, result: null, reason: null });
const MAX_SNAPSHOTS_IN_BUNDLE = 12;
const SYNC_TIMEOUT_MS = 30_000;
const CONFIRM_TIMEOUT_MS = 3 * 60_000;

export class FriendLink {
  private s = initial();
  private listeners = new Set<() => void>();
  private sig: SignalingHandle | null = null;
  private peer: PeerHandle | null = null;
  private gen = 0;
  private timers: { hello?: number; connect?: number; expiry?: number; stage?: number } = {};
  private sigDone = false;
  private dcOpen = false;
  private myName = '';
  private id: FriendIdentity | null = null;
  private nonce = '';
  private peerHello = false;
  private helloAcked = false;
  private binding = '';
  private authed = false;
  private peerConfirmed = false;
  private friend: Friend | undefined;
  private sentBundle = false;
  private gotBundle = false;
  private gotDone = false;
  private reasm = new Reassembler();
  private chain: Promise<void> = Promise.resolve();
  private hostToken: string | null = null;

  constructor(private deps: FriendLinkDeps) {}

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getState = (): FriendLinkState => this.s;
  private set(p: Partial<FriendLinkState>) { this.s = { ...this.s, ...p }; this.listeners.forEach((l) => l()); }
  get busy() { return this.s.phase !== 'idle' && this.s.phase !== 'closed' && this.s.phase !== 'done'; }

  // ---------- действия человека ----------
  /** Хост: создать приглашение (код). */
  async invite(): Promise<void> { await this.begin('host', null); }

  /** Гость: войти по коду. */
  async join(code: string): Promise<void> {
    const norm = normalizeCode(code);
    if (!norm) { this.reset(); this.finish('bad-code'); return; }
    await this.begin('guest', norm);
  }

  /** Подтвердить добавление нового человека (после сверки кода и отпечатка). */
  confirm(): void {
    if (this.s.phase !== 'confirm' || this.s.iConfirmed) return;
    this.set({ iConfirmed: true });
    this.send({ k: 'confirm' });
    void this.proceed();
  }

  decline(): void {
    if (this.s.phase !== 'confirm') return;
    this.send({ k: 'decline' });
    this.finish('declined', true);
  }

  cancel(): void {
    if (this.dcOpen) this.send({ k: 'bye', reason: 'cancel' });
    this.teardown(true);
    this.gen++;
    this.reset();
  }

  /** Убрать экран результата/ошибки. */
  dismiss(): void { if (this.s.phase === 'closed' || this.s.phase === 'done') this.reset(); }

  // ---------- запуск ----------
  private async begin(role: 'host' | 'guest', code: string | null): Promise<void> {
    if (this.busy) return;
    this.reset();
    const g = this.gen;
    const id = await this.deps.store.identity();
    if (g !== this.gen) return;
    if (!id) { this.finish('no-profile'); return; }
    if (!this.deps.relayUrl) { this.finish('no-relay'); return; }
    this.id = id;
    this.myName = id.displayName;
    this.nonce = randomNonce();
    this.set({ phase: role === 'host' ? 'creating' : 'joining', role, code });
    try {
      this.peer = this.deps.peer(role, {
        onOpen: () => { if (g === this.gen) this.onDcOpen(); },
        onMessage: (t) => { if (g === this.gen) this.enqueue(t); },
        onClose: () => { if (g === this.gen) this.onPeerClosed(); }
      }, this.deps.peerOptions);
    } catch { this.finish('unsupported'); return; }
    this.sig = this.deps.signaling(this.deps.relayUrl, {
      onOpen: () => { if (g === this.gen) this.onSigOpen(); },
      onMessage: (m) => { if (g === this.gen) this.onRelay(m); },
      onClose: () => { if (g === this.gen) this.onSigClosed(); }
    });
  }

  private onSigOpen(): void {
    if (this.s.role === 'host') this.sig?.send({ t: 'create', name: this.myName, proto: PROTO_VERSION, app: APP_VERSION });
    else this.sig?.send({ t: 'join', code: this.s.code, name: this.myName, proto: PROTO_VERSION, app: APP_VERSION });
  }

  private onRelay(m: RelayMsg): void {
    if (this.sigDone) return;
    const ph = this.s.phase;
    const g = this.gen;
    switch (m.t) {
      case 'created':
        if (ph !== 'creating' || typeof m.code !== 'string' || typeof m.hostToken !== 'string') return;
        this.hostToken = m.hostToken;
        this.set({ phase: 'waiting', code: m.code, expiresAt: typeof m.expiresAt === 'number' ? m.expiresAt : this.deps.now() + 600_000 });
        this.timers.expiry = setTimeout(() => { if (this.s.phase === 'waiting') this.finish('expired'); }, Math.max(0, (this.s.expiresAt ?? 0) - this.deps.now()));
        break;
      case 'peer':
        if (this.s.role !== 'host' || ph !== 'waiting') return;
        if (m.proto !== PROTO_VERSION) { this.finish('version'); return; }
        clearTimeout(this.timers.expiry);
        this.set({ phase: 'connecting' });
        this.startConnectTimer();
        this.peer?.createOffer().then((sdp) => { if (g === this.gen) this.sig?.send({ t: 'offer', sdp }); }).catch(() => { if (g === this.gen) this.finish('ice-failed'); });
        break;
      case 'joined':
        if (this.s.role !== 'guest' || ph !== 'joining') return;
        this.set({ phase: 'connecting' });
        this.startConnectTimer();
        break;
      case 'offer':
        if (this.s.role !== 'guest' || ph !== 'connecting' || typeof m.sdp !== 'string') return;
        this.peer?.acceptOffer(m.sdp).then((a) => { if (g !== this.gen) return; this.sig?.send({ t: 'answer', sdp: a }); this.sigDone = true; }).catch(() => { if (g === this.gen) this.finish('ice-failed'); });
        break;
      case 'answer':
        if (this.s.role !== 'host' || ph !== 'connecting' || typeof m.sdp !== 'string') return;
        this.peer?.acceptAnswer(m.sdp).then(() => { if (g === this.gen) this.sigDone = true; }).catch(() => { if (g === this.gen) this.finish('ice-failed'); });
        break;
      case 'peer-left':
        if (ph === 'waiting' || ph === 'connecting' || ph === 'joining') this.finish('peer-left');
        break;
      case 'error': {
        const map: Record<string, FriendReason> = { 'bad-code': 'bad-code', 'room-full': 'room-full', 'rate-limit': 'rate-limit', 'version': 'version', 'expired': 'expired' };
        if (m.code !== 'forbidden') this.finish(map[String(m.code)] ?? 'generic');
        break;
      }
    }
  }

  private onSigClosed(): void {
    if (this.sigDone || this.dcOpen) return;
    const ph = this.s.phase;
    if (ph === 'creating' || ph === 'joining' || ph === 'waiting' || ph === 'connecting') this.finish('offline');
  }

  private startConnectTimer(): void {
    clearTimeout(this.timers.connect);
    this.timers.connect = setTimeout(() => { if (this.s.phase === 'connecting' && !this.dcOpen) this.finish('ice-failed'); }, LIMITS.connectMs);
  }

  // ---------- канал ----------
  private onDcOpen(): void {
    this.dcOpen = true;
    this.sigDone = true;
    clearTimeout(this.timers.connect);
    this.sig?.close();
    this.sig = null;
    const hello = () => this.send({ k: 'hello', v: FRIEND_PROTO, card: { profileId: this.id!.profileId, publicKey: this.id!.publicKey, displayName: this.id!.displayName }, nonce: this.nonce, got: this.peerHello });
    hello();
    // первое сообщение после открытия канала может потеряться, поэтому hello повторяется до подтверждения
    this.timers.hello = setInterval(() => {
      const ph = this.s.phase;
      if (this.helloAcked || ph === 'idle' || ph === 'closed' || ph === 'done') { clearInterval(this.timers.hello); return; }
      hello();
    }, 600);
    this.armStage(CONFIRM_TIMEOUT_MS);
  }

  private armStage(ms: number): void {
    clearTimeout(this.timers.stage);
    this.timers.stage = setTimeout(() => {
      const ph = this.s.phase;
      if (ph === 'syncing') this.finish('sync-failed', true);
      else if (ph !== 'done' && ph !== 'closed' && ph !== 'idle') this.finish('timeout', true);
    }, ms);
  }

  private onPeerClosed(): void {
    const ph = this.s.phase;
    if (ph === 'done' || ph === 'closed' || ph === 'idle') return;
    if (ph === 'syncing' && this.sentBundle && this.gotBundle) { void this.complete(); return; }
    this.finish(ph === 'connecting' ? 'ice-failed' : ph === 'syncing' ? 'sync-failed' : 'peer-left');
  }

  private send(w: FriendWire): boolean { return this.peer?.send(encodeFriendWire(w)) ?? false; }

  /** Сообщения обрабатываются строго по очереди: проверки подписей асинхронны, а порядок важен. */
  private enqueue(text: string): void {
    const g = this.gen;
    this.chain = this.chain.then(() => (g === this.gen ? this.onWire(text) : undefined)).catch(() => { if (g === this.gen) this.finish('generic', true); });
  }

  private async onWire(text: string): Promise<void> {
    const w = parseFriendWire(text);
    if (!w) return;
    switch (w.k) {
      case 'hello': return this.onHello(w);
      case 'auth': return this.onAuth(w.sig);
      case 'confirm': if (this.authed) { this.peerConfirmed = true; await this.proceed(); } return;
      case 'decline': if (this.authed && this.s.phase !== 'syncing') this.finish('declined'); return;
      case 'bye': if (this.s.phase !== 'done') { if (this.s.phase === 'syncing' && this.sentBundle && this.gotBundle) await this.complete(); else this.finish(w.reason === 'blocked' ? 'declined' : w.reason === 'key' ? 'key-changed' : 'peer-left'); } return;
      case 'part': return this.onPart(w);
      case 'done': this.gotDone = true; return this.maybeComplete();
    }
  }

  private async onHello(w: Extract<FriendWire, { k: 'hello' }>): Promise<void> {
    const ph = this.s.phase;
    if (ph !== 'connecting' && ph !== 'verifying') return;
    if (w.got) this.helloAcked = true;
    if (this.peerHello) return;
    if (w.v !== FRIEND_PROTO) { this.send({ k: 'bye', reason: 'version' }); this.finish('version', true); return; }
    if ((await profileIdFor(w.card.publicKey)) !== w.card.profileId) { this.finish('bad-auth', true); return; }
    if (w.card.profileId === this.id!.profileId) { this.finish('self', true); return; }
    this.friend = await this.deps.store.getFriend(w.card.profileId);
    if (this.friend?.status === 'blocked') { this.send({ k: 'bye', reason: 'blocked' }); this.finish('blocked', true); return; }
    if (this.friend && this.friend.publicKey !== w.card.publicKey) { this.send({ k: 'bye', reason: 'key' }); this.finish('key-changed', true); return; }
    this.peerHello = true;
    this.binding = this.peer!.binding();
    const sas = await this.peer!.sas();
    this.set({ phase: 'verifying', peer: w.card, sas, known: !!this.friend });
    // подпись привязана к отпечаткам именно этого канала: переложить её на другой нельзя
    this.send({ k: 'auth', sig: await this.id!.sign(authText(this.binding, w.nonce, this.id!.profileId)) });
  }

  private async onAuth(sig: string): Promise<void> {
    const peer = this.s.peer;
    if (!peer || this.authed) return;
    if (!(await verifyText(peer.publicKey, authText(this.binding, this.nonce, peer.profileId), sig))) { this.finish('bad-auth', true); return; }
    this.authed = true;
    if (this.friend) { this.confirmAuto(); } else this.set({ phase: 'confirm' });
    await this.proceed();
  }

  /** Уже добавленный друг: подтверждение не спрашиваем, ключ закреплён ранее. */
  private confirmAuto(): void { this.set({ iConfirmed: true }); this.send({ k: 'confirm' }); }

  private async proceed(): Promise<void> {
    if (!this.authed || !this.s.iConfirmed || !this.peerConfirmed || this.s.phase === 'syncing' || this.s.phase === 'done') return;
    const peer = this.s.peer!;
    let added = false;
    if (!this.friend) { await this.deps.store.addFriend(peer); this.friend = await this.deps.store.getFriend(peer.profileId); added = true; }
    else await this.deps.store.touchFriend(peer);
    this.set({ phase: 'syncing', result: { added, received: 0, rejected: 0 } });
    this.armStage(SYNC_TIMEOUT_MS);
    // отдаём только то, что разрешено этому другу
    const mine = this.friend?.permissions.leaderboard ? await this.deps.store.mySnapshots() : [];
    const parts = splitMessage(randomNonce().slice(0, 12), JSON.stringify({ snapshots: mine.slice(0, MAX_SNAPSHOTS_IN_BUNDLE) }));
    for (const part of parts) if (!this.send({ k: 'part', part })) { this.finish('sync-failed', true); return; }
    this.send({ k: 'done' });
    this.sentBundle = true;
    this.maybeComplete();
  }

  private async onPart(w: Extract<FriendWire, { k: 'part' }>): Promise<void> {
    if (!this.authed || this.s.phase !== 'syncing' || this.gotBundle) return;
    const whole = this.reasm.push(w.part);
    if (whole === 'bad') { this.finish('sync-failed', true); return; }
    if (whole === null) return;
    let raw: unknown[] = [];
    try { const o = JSON.parse(whole) as { snapshots?: unknown }; raw = Array.isArray(o.snapshots) ? o.snapshots.slice(0, MAX_SNAPSHOTS_IN_BUNDLE) : []; } catch { this.finish('sync-failed', true); return; }
    const peer = this.s.peer!;
    const ok: LeaderboardSnapshot[] = [];
    let rejected = 0;
    for (const r of raw) {
      const c = await checkSnapshot(r, this.deps.now(), peer.publicKey);
      if (c.result === 'ok' && c.snapshot!.profileId === peer.profileId) ok.push(c.snapshot!); else rejected++;
    }
    const saved = ok.length ? await this.deps.store.saveSnapshots(peer.profileId, ok) : 0;
    this.gotBundle = true;
    this.set({ result: { ...(this.s.result ?? { added: false }), received: saved, rejected } });
    this.maybeComplete();
  }

  private maybeComplete(): void { if (this.sentBundle && this.gotBundle && this.gotDone) void this.complete(); }

  private async complete(): Promise<void> {
    if (this.s.phase === 'done') return;
    this.send({ k: 'bye', reason: 'done' });
    this.teardown(true);
    this.gen++;
    this.set({ phase: 'done' });
  }

  // ---------- завершение ----------
  private clearTimers(): void {
    for (const k of Object.keys(this.timers) as Array<keyof typeof this.timers>) { clearTimeout(this.timers[k]); clearInterval(this.timers[k]); delete this.timers[k]; }
  }

  private teardown(delayPeer: boolean): void {
    this.clearTimers();
    const { peer, sig } = this;
    this.peer = null; this.sig = null;
    if (sig && this.s.role === 'host' && this.s.phase === 'waiting' && this.hostToken) sig.send({ t: 'close', code: this.s.code, hostToken: this.hostToken });
    sig?.close();
    if (peer) { if (delayPeer) setTimeout(() => peer.close(), 250); else peer.close(); }
  }

  private finish(reason: FriendReason, notify = false): void {
    if (notify && this.dcOpen) this.send({ k: 'bye', reason: reason === 'declined' ? 'declined' : 'error' });
    this.teardown(notify);
    this.gen++;
    this.set({ phase: 'closed', reason, sas: null, expiresAt: null });
  }

  private reset(): void {
    this.teardown(false);
    this.gen++;
    this.sigDone = false; this.dcOpen = false; this.peerHello = false; this.helloAcked = false; this.authed = false; this.peerConfirmed = false;
    this.friend = undefined; this.sentBundle = false; this.gotBundle = false; this.gotDone = false; this.hostToken = null; this.binding = '';
    this.reasm = new Reassembler();
    this.chain = Promise.resolve();
    this.s = initial();
    this.listeners.forEach((l) => l());
  }
}
