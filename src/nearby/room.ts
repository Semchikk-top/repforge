// Менеджер комнаты: один на всё приложение, живёт вне React (StrictMode не создаст второе соединение).
// Соединения создаются только по действию человека: createRoom() / joinRoom() вызываются из обработчиков кнопок.
import { APP_VERSION, LIMITS, PROTO_VERSION, RELAY_URL } from './config';
import { normalizeCode } from './code';
import { cleanText, encodeWire, MAX_MESSAGES, MAX_NAME, MAX_TEXT, parseWire, quickText, type QuickId, type Wire } from './messages';
import { createPeerLink, type PeerFactory, type PeerHandle } from './peer';
import { PresenceSender, type Presence, type RemotePresence } from './presence';
import { connectSignaling, type RelayMsg, type SignalingFactory, type SignalingHandle } from './signaling';

export type Phase =
  | 'idle'        // комнаты нет
  | 'creating'    // хост: связываемся с релеем
  | 'waiting'     // хост: код выдан, ждём друга
  | 'joining'     // гость: связываемся с релеем
  | 'connecting'  // обмен SDP и установка прямого канала
  | 'approval'    // хост: сверить код и разрешить вход
  | 'awaiting'    // гость: ждём решения хоста
  | 'active'      // чат и presence
  | 'closed';     // комната закончилась; причина в reason

export type CloseReason =
  | 'no-relay' | 'offline' | 'bad-code' | 'room-full' | 'rate-limit' | 'version' | 'expired'
  | 'ice-failed' | 'rejected' | 'peer-left' | 'lost' | 'timeout' | 'unsupported' | 'generic';

export const REASON_TEXT: Record<CloseReason, string> = {
  'no-relay': 'В этой сборке не задан адрес релея, поэтому комната по коду недоступна.',
  'offline': 'Нет интернета для подключения. Комната по коду требует сеть.',
  'bad-code': 'Неверный или просроченный код.',
  'room-full': 'Комната занята: второй участник уже есть.',
  'rate-limit': 'Слишком много попыток. Подождите минуту.',
  'version': 'Обновите приложение: у друга другая версия комнаты.',
  'expired': 'Код истёк. Создайте комнату заново.',
  'ice-failed': 'Не удалось соединиться. Проверьте, что оба на одном хотспоте, VPN выключен, в публичном Wi-Fi нет изоляции клиентов.',
  'rejected': 'Хост отклонил вход.',
  'peer-left': 'Друг вышел из комнаты.',
  'lost': 'Связь потеряна. Создайте комнату заново: понадобится новый код.',
  'timeout': 'Время ожидания подтверждения вышло.',
  'unsupported': 'Этот браузер не умеет прямое соединение между телефонами.',
  'generic': 'Что-то пошло не так. Попробуйте ещё раз.'
};

export interface ChatMessage {
  id: number;
  from: 'me' | 'peer';
  kind: 'text' | 'call';
  text: string;
  at: number;
}

export interface RoomState {
  phase: Phase;
  role: 'host' | 'guest' | null;
  code: string | null;
  expiresAt: number | null;
  myName: string;
  peerName: string;
  /** Код сверки (6 цифр) — одинаковый на обоих экранах, если связь не подменена. */
  sas: string | null;
  reason: CloseReason | null;
  messages: ChatMessage[];
  unread: number;
  remote: RemotePresence | null;
  sharePresence: boolean;
}

export type RoomEvent =
  | { type: 'approval'; name: string }
  | { type: 'chat'; text: string }
  | { type: 'call' };

export interface RoomDeps {
  signaling: SignalingFactory;
  peer: PeerFactory;
  relayUrl: string;
  now: () => number;
}

const CALL_TX_COOLDOWN_MS = 5000;
const CALL_RX_COOLDOWN_MS = 3000;
const FLOOD_WINDOW_MS = 5000;
const FLOOD_MAX = 20;

const initialState = (share = true): RoomState => ({
  phase: 'idle', role: null, code: null, expiresAt: null, myName: '', peerName: '', sas: null, reason: null,
  messages: [], unread: 0, remote: null, sharePresence: share
});

export class RoomManager {
  private s: RoomState = initialState();
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: RoomEvent) => void>();
  private deps: RoomDeps;

  private sig: SignalingHandle | null = null;
  private peer: PeerHandle | null = null;
  private gen = 0; // поколение сессии: события от закрытых соединений игнорируются
  private sigDone = false;
  private dcOpen = false;
  private peerHello = false;
  private helloAcked = false; // друг подтвердил, что получил наш hello
  private hostToken: string | null = null;
  private resumeTries = 0;
  private timers: { hello?: number; connect?: number; approval?: number; expiry?: number; heartbeat?: number; alive?: number; resume?: number } = {};
  private lastRx = 0;
  private lastCallRx = -Infinity;
  private lastCallTx = -Infinity;
  private rx: number[] = [];
  private local: Presence | null = null;
  private sender = new PresenceSender();
  private viewing = false;
  private nextId = 1;

  constructor(deps?: Partial<RoomDeps>) {
    this.deps = {
      signaling: deps?.signaling ?? connectSignaling,
      peer: deps?.peer ?? createPeerLink,
      relayUrl: deps?.relayUrl ?? RELAY_URL,
      now: deps?.now ?? (() => Date.now())
    };
  }

  // ---------- подписка для React ----------
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getState = (): RoomState => this.s;
  onEvent(fn: (e: RoomEvent) => void): () => void { this.eventListeners.add(fn); return () => { this.eventListeners.delete(fn); }; }

  private set(patch: Partial<RoomState>) { this.s = { ...this.s, ...patch }; this.listeners.forEach((l) => l()); }
  private emit(e: RoomEvent) { this.eventListeners.forEach((l) => l(e)); }

  /** Идёт ли сейчас какая-либо комната (для кнопок и индикаторов). */
  get busy(): boolean { return this.s.phase !== 'idle' && this.s.phase !== 'closed'; }

  // ---------- действия человека ----------
  createRoom(name: string, sharePresence: boolean): void {
    if (this.busy) return;
    this.begin('host', name, sharePresence, null);
  }

  joinRoom(code: string, name: string, sharePresence = true): void {
    if (this.busy) return;
    const norm = normalizeCode(code);
    if (!norm) { this.reset(sharePresence); this.finish('bad-code'); return; }
    this.begin('guest', name, sharePresence, norm);
  }

  /** Хост разрешает вход после сверки кода. */
  approve(): void {
    if (this.s.phase !== 'approval' || this.s.role !== 'host') return;
    this.sendWire({ k: 'approve' });
    this.activate();
  }

  /** Хост отклоняет вход: гость видит отказ, комната закрывается. */
  reject(): void {
    if (this.s.phase !== 'approval' || this.s.role !== 'host') return;
    this.sendWire({ k: 'reject' });
    this.leaveSilently(true);
  }

  /** Выход из комнаты из любого состояния: друг получает bye, сообщения стираются. */
  leave(): void {
    const notify = this.dcOpen && this.s.phase !== 'idle';
    if (notify) this.sendWire({ k: 'bye' });
    this.leaveSilently(notify);
  }

  /** Убрать экран с причиной закрытия (после «Попробовать снова»). */
  dismiss(): void {
    if (this.s.phase === 'closed') this.reset(this.s.sharePresence);
  }

  setSharePresence(on: boolean): void { this.set({ sharePresence: on }); }

  sendChat(text: string): boolean {
    const t = cleanText(text, MAX_TEXT);
    if (!t || this.s.phase !== 'active') return false;
    if (!this.sendWire({ k: 'chat', text: t })) return false;
    this.append({ from: 'me', kind: 'text', text: t });
    return true;
  }

  sendQuick(id: QuickId): boolean { return this.sendChat(quickText(id, this.local)); }

  /** «Позвать»: вибрация и звук у друга, без текста. Не чаще раза в 5 секунд. */
  call(): boolean {
    if (this.s.phase !== 'active') return false;
    const now = this.deps.now();
    if (now - this.lastCallTx < CALL_TX_COOLDOWN_MS) return false;
    if (!this.sendWire({ k: 'call' })) return false;
    this.lastCallTx = now;
    this.append({ from: 'me', kind: 'call', text: 'Вы позвали' });
    return true;
  }

  /** Экран комнаты открыт: новые сообщения считаются прочитанными. */
  setViewing(v: boolean): void {
    this.viewing = v;
    if (v && this.s.unread > 0) this.set({ unread: 0 });
  }

  /** Текущее состояние тренировки от приложения; отправляется при смене упражнения/подхода/таймера. */
  updateLocalPresence(p: Presence): void {
    this.local = p;
    if (this.s.phase === 'active' && this.sender.shouldSend(p, this.deps.now())) this.pushPresence();
  }

  /** Приложение вернулось на экран: после сна телефона даём связи ещё немного времени. */
  onForeground(): void {
    if (this.s.phase !== 'active') return;
    this.lastRx = Math.max(this.lastRx, this.deps.now() - LIMITS.deadAfterMs + 10_000);
  }

  // ---------- запуск ----------
  private begin(role: 'host' | 'guest', name: string, share: boolean, code: string | null): void {
    this.reset(share);
    const g = this.gen;
    const myName = cleanText(name, MAX_NAME) || 'Напарник';
    if (!this.deps.relayUrl) { this.set({ myName }); this.finish('no-relay'); return; }
    this.set({ phase: role === 'host' ? 'creating' : 'joining', role, myName, code });
    try {
      this.peer = this.deps.peer(role, {
        onOpen: () => { if (g === this.gen) this.onDcOpen(); },
        onMessage: (text) => { if (g === this.gen) this.onWire(text); },
        onClose: () => { if (g === this.gen) this.onPeerClosed(); }
      });
    } catch {
      this.finish('unsupported');
      return;
    }
    this.openSignaling(g);
  }

  private openSignaling(g: number): void {
    this.sig = this.deps.signaling(this.deps.relayUrl, {
      onOpen: () => { if (g === this.gen) this.onSigOpen(); },
      onMessage: (m) => { if (g === this.gen) this.onRelay(m); },
      onClose: () => { if (g === this.gen) this.onSigClosed(); }
    });
  }

  private onSigOpen(): void {
    const { role, myName, code } = this.s;
    if (role === 'host') {
      if (this.hostToken && code) this.sig?.send({ t: 'resume', code, hostToken: this.hostToken });
      else this.sig?.send({ t: 'create', name: myName, proto: PROTO_VERSION, app: APP_VERSION });
    } else this.sig?.send({ t: 'join', code, name: myName, proto: PROTO_VERSION, app: APP_VERSION });
  }

  // ---------- сообщения релея ----------
  private onRelay(m: RelayMsg): void {
    if (this.sigDone) return;
    const ph = this.s.phase;
    switch (m.t) {
      case 'created':
        if (ph !== 'creating' || typeof m.code !== 'string' || typeof m.hostToken !== 'string') return;
        this.hostToken = m.hostToken;
        this.set({ phase: 'waiting', code: m.code, expiresAt: typeof m.expiresAt === 'number' ? m.expiresAt : this.deps.now() + 10 * 60_000 });
        this.timers.expiry = setTimeout(() => { if (this.s.phase === 'waiting') { this.sig?.send({ t: 'close', code: this.s.code, hostToken: this.hostToken }); this.finish('expired'); } },
          Math.max(0, (this.s.expiresAt ?? 0) - this.deps.now()));
        break;
      case 'resumed':
        this.resumeTries = 0;
        break;
      case 'peer':
        if (this.s.role !== 'host' || ph !== 'waiting') return;
        if (m.proto !== PROTO_VERSION) { this.sig?.send({ t: 'close', code: this.s.code, hostToken: this.hostToken }); this.finish('version'); return; }
        clearTimeout(this.timers.expiry);
        this.set({ phase: 'connecting', peerName: cleanText(m.name, MAX_NAME) });
        this.startConnectTimer();
        this.startOffer();
        break;
      case 'joined':
        if (this.s.role !== 'guest' || ph !== 'joining') return;
        this.set({ phase: 'connecting', peerName: cleanText(m.hostName, MAX_NAME) });
        this.startConnectTimer();
        break;
      case 'offer':
        if (this.s.role !== 'guest' || ph !== 'connecting' || typeof m.sdp !== 'string') return;
        this.answerOffer(m.sdp);
        break;
      case 'answer':
        if (this.s.role !== 'host' || ph !== 'connecting' || typeof m.sdp !== 'string') return;
        this.acceptAnswer(m.sdp);
        break;
      case 'peer-left':
        if (ph === 'waiting' || ph === 'connecting' || ph === 'joining') this.finish('peer-left');
        break;
      case 'error':
        this.onRelayError(String(m.code ?? ''));
        break;
    }
  }

  private onRelayError(code: string): void {
    const map: Record<string, CloseReason> = {
      'bad-code': 'bad-code', 'room-full': 'room-full', 'rate-limit': 'rate-limit', 'version': 'version', 'expired': 'expired'
    };
    if (code === 'forbidden') return;
    this.finish(map[code] ?? 'generic');
  }

  private onSigClosed(): void {
    if (this.sigDone || this.dcOpen) return;
    const ph = this.s.phase;
    // хост ждёт друга и потерял связь с релеем — пробуем вернуться в ту же комнату
    if (ph === 'waiting' && this.s.role === 'host' && this.hostToken && this.resumeTries < 3) {
      const g = this.gen;
      const delay = 1000 * 2 ** this.resumeTries++;
      this.timers.resume = setTimeout(() => { if (g === this.gen && this.s.phase === 'waiting') this.openSignaling(g); }, delay);
      return;
    }
    if (ph === 'creating' || ph === 'joining' || ph === 'waiting' || ph === 'connecting') this.finish('offline');
  }

  // ---------- SDP ----------
  private startOffer(): void {
    const g = this.gen;
    this.peer?.createOffer()
      .then((sdp) => { if (g === this.gen) this.sig?.send({ t: 'offer', sdp }); })
      .catch(() => { if (g === this.gen) this.finish('ice-failed'); });
  }

  private answerOffer(sdp: string): void {
    const g = this.gen;
    this.peer?.acceptOffer(sdp)
      .then((answer) => { if (g !== this.gen) return; this.sig?.send({ t: 'answer', sdp: answer }); this.sigDone = true; })
      .catch(() => { if (g === this.gen) this.finish('ice-failed'); });
  }

  private acceptAnswer(sdp: string): void {
    const g = this.gen;
    this.peer?.acceptAnswer(sdp)
      .then(() => { if (g === this.gen) this.sigDone = true; })
      .catch(() => { if (g === this.gen) this.finish('ice-failed'); });
  }

  private startConnectTimer(): void {
    clearTimeout(this.timers.connect);
    this.timers.connect = setTimeout(() => { if (this.s.phase === 'connecting' && !this.dcOpen) this.finish('ice-failed'); }, LIMITS.connectMs);
  }

  // ---------- канал данных ----------
  private onDcOpen(): void {
    this.dcOpen = true;
    this.sigDone = true;
    clearTimeout(this.timers.connect);
    this.sig?.close();
    this.sig = null;
    // Сообщение, отправленное в первый миг после открытия канала, может потеряться, если у друга он ещё не готов
    // (так и бывало в Chromium). Поэтому hello повторяется, пока не придёт ответный.
    const hello = () => this.sendWire({ k: 'hello', name: this.s.myName, proto: PROTO_VERSION, app: APP_VERSION, got: this.peerHello });
    hello();
    this.timers.hello = setInterval(() => {
      const ph = this.s.phase;
      if (this.helloAcked || (ph !== 'connecting' && ph !== 'approval' && ph !== 'awaiting')) { clearInterval(this.timers.hello); return; }
      hello();
    }, 600);
    const g = this.gen;
    this.peer?.sas()
      .then((sas) => { if (g === this.gen) { this.set({ sas }); this.tryAdvance(); } })
      .catch(() => { if (g === this.gen) this.finish('generic', true); });
    this.tryAdvance();
  }

  /** Канал открыт, код сверки посчитан и имя друга пришло по защищённому каналу: показываем экран подтверждения. */
  private tryAdvance(): void {
    if (this.s.phase !== 'connecting' || !this.dcOpen || !this.s.sas || !this.peerHello) return;
    this.set({ phase: this.s.role === 'host' ? 'approval' : 'awaiting' });
    this.timers.approval = setTimeout(() => {
      if (this.s.phase === 'approval' || this.s.phase === 'awaiting') this.finish('timeout', true);
    }, LIMITS.approvalMs);
    if (this.s.role === 'host') this.emit({ type: 'approval', name: this.s.peerName });
  }

  private activate(): void {
    clearTimeout(this.timers.approval);
    this.lastRx = this.deps.now();
    this.sender.reset();
    this.set({ phase: 'active', unread: 0 });
    this.timers.heartbeat = setInterval(() => this.heartbeat(), LIMITS.heartbeatMs);
    this.timers.alive = setInterval(() => this.checkAlive(), 5000);
    if (this.local) this.pushPresence();
  }

  private heartbeat(): void {
    if (this.s.phase !== 'active') return;
    if (this.local) this.pushPresence(); else this.sendWire({ k: 'ping' });
  }

  private checkAlive(): void {
    if (this.s.phase === 'active' && this.deps.now() - this.lastRx > LIMITS.deadAfterMs) this.finish('lost', true);
  }

  private pushPresence(): void {
    if (!this.local) return;
    const now = this.deps.now();
    const p = { ...this.local, updatedAt: now };
    if (this.sendWire({ k: 'presence', p })) this.sender.mark(p, now);
  }

  private onPeerClosed(): void {
    const ph = this.s.phase;
    if (ph === 'active') this.finish('lost', true);
    else if (ph === 'approval' || ph === 'awaiting') this.finish('peer-left');
    else if (ph === 'connecting') this.finish('ice-failed');
  }

  private onWire(text: string): void {
    const w = parseWire(text);
    if (!w) return; // мусор молча отбрасываем
    const now = this.deps.now();
    const ph = this.s.phase;
    if (ph === 'active') this.lastRx = now;
    switch (w.k) {
      case 'hello':
        if (ph !== 'connecting' && ph !== 'approval' && ph !== 'awaiting') return;
        if (w.got) this.helloAcked = true;
        if (this.peerHello) break;
        if (w.proto !== PROTO_VERSION) { this.sendWire({ k: 'bye' }); this.finish('version', true); return; }
        this.peerHello = true;
        this.set({ peerName: w.name });
        this.tryAdvance();
        break;
      case 'approve':
        if (this.s.role === 'guest' && ph === 'awaiting') this.activate();
        break;
      case 'reject':
        if (this.s.role === 'guest' && ph === 'awaiting') this.finish('rejected');
        break;
      case 'bye':
        if (ph === 'connecting' || ph === 'approval' || ph === 'awaiting' || ph === 'active') this.finish('peer-left');
        break;
      case 'call':
        if (ph === 'active') this.onCall(now);
        break;
      case 'chat':
        if (ph === 'active') this.onChat(w.text, now);
        break;
      case 'presence':
        if (ph === 'active') this.set({ remote: { p: w.p, receivedAt: now } });
        break;
      case 'ping':
        break;
    }
  }

  private flooded(now: number): boolean {
    this.rx = this.rx.filter((t) => now - t < FLOOD_WINDOW_MS);
    if (this.rx.length >= FLOOD_MAX) return true;
    this.rx.push(now);
    return false;
  }

  private onChat(text: string, now: number): void {
    if (this.flooded(now)) return;
    this.append({ from: 'peer', kind: 'text', text });
    this.emit({ type: 'chat', text });
  }

  private onCall(now: number): void {
    if (now - this.lastCallRx < CALL_RX_COOLDOWN_MS) return;
    this.lastCallRx = now;
    this.append({ from: 'peer', kind: 'call', text: 'Зовёт вас' });
    this.emit({ type: 'call' });
  }

  private append(m: Omit<ChatMessage, 'id' | 'at'>): void {
    const msg: ChatMessage = { ...m, id: this.nextId++, at: this.deps.now() };
    const messages = [...this.s.messages, msg].slice(-MAX_MESSAGES);
    this.set({ messages, unread: m.from === 'peer' && !this.viewing ? this.s.unread + 1 : this.s.unread });
  }

  private sendWire(w: Wire): boolean { return this.peer?.send(encodeWire(w)) ?? false; }

  // ---------- завершение ----------
  private clearTimers(): void {
    for (const k of Object.keys(this.timers) as Array<keyof typeof this.timers>) {
      clearTimeout(this.timers[k]);
      clearInterval(this.timers[k]);
      delete this.timers[k];
    }
  }

  /** Закрыть соединения и остановить таймеры; peer закрывается с задержкой, чтобы успел уйти bye. */
  private teardown(delayPeer: boolean): void {
    this.clearTimers();
    const { peer, sig } = this;
    this.peer = null; this.sig = null;
    if (sig && this.s.role === 'host' && this.s.phase === 'waiting' && this.hostToken) sig.send({ t: 'close', code: this.s.code, hostToken: this.hostToken });
    sig?.close();
    if (peer) { if (delayPeer) setTimeout(() => peer.close(), 250); else peer.close(); }
    this.sigDone = false; this.dcOpen = false; this.peerHello = false; this.helloAcked = false; this.hostToken = null; this.resumeTries = 0;
    this.sender.reset();
  }

  /** Сессия закончилась по причине reason; экран покажет её текст. При потере связи переписка остаётся видна. */
  private finish(reason: CloseReason, notifyPeer = false): void {
    if (notifyPeer && this.dcOpen) this.sendWire({ k: 'bye' });
    this.teardown(notifyPeer);
    this.gen++;
    const keep = reason === 'lost';
    this.set({ phase: 'closed', reason, sas: null, remote: null, expiresAt: null, messages: keep ? this.s.messages : [], unread: 0 });
  }

  private leaveSilently(delayPeer: boolean): void {
    this.teardown(delayPeer);
    this.gen++;
    this.reset(this.s.sharePresence);
  }

  /** Новое чистое состояние (имя и тумблер presence сохраняются на уровне интерфейса). */
  private reset(share: boolean): void {
    this.teardown(false);
    this.gen++;
    this.rx = [];
    this.lastCallRx = -Infinity; this.lastCallTx = -Infinity;
    this.s = initialState(share);
    this.listeners.forEach((l) => l());
  }
}

export const room = new RoomManager();
