// Логика комнат без привязки к транспорту: соединение — любой объект с send(obj) и close().
// Релей не разбирает SDP и не хранит его: он только пересылает offer/answer между двумя участниками.
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// 32 символа: без 0/O и 1/I, чтобы код не путали при чтении с экрана
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MIN_PROTO = 1;
export const MAX_PROTO = 1;
export const MAX_SDP = 64 * 1024;
export const MAX_NAME = 24;

export function generateCode(rand = randomInt) {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[rand(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** «k7m4 p2qx» → «K7M4-P2QX»; null, если код невозможен. */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== 8) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function cleanName(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME);
}

/** Скользящее окно: не больше `max` событий на ключ за `windowMs`. */
export class RateLimiter {
  constructor(now = () => Date.now()) { this.now = now; this.hits = new Map(); }
  allow(key, max, windowMs) {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length >= max) { this.hits.set(key, list); return false; }
    list.push(t);
    this.hits.set(key, list);
    return true;
  }
  count(key, windowMs) {
    const t = this.now();
    return (this.hits.get(key) ?? []).filter((x) => t - x < windowMs).length;
  }
  record(key) {
    const list = this.hits.get(key) ?? [];
    list.push(this.now());
    this.hits.set(key, list);
  }
  sweep(windowMs = 120_000) {
    const t = this.now();
    for (const [k, list] of this.hits) {
      const fresh = list.filter((x) => t - x < windowMs);
      if (fresh.length) this.hits.set(k, fresh); else this.hits.delete(k);
    }
  }
}

const eqToken = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export class RoomStore {
  /**
   * @param {object} o
   * @param {number} [o.ttlMs] время жизни кода
   * @param {number} [o.hostGraceMs] сколько ждать возвращения хоста после обрыва связи
   * @param {number} [o.maxRooms]
   * @param {{create:number, join:number, badJoin:number}} [o.limits] попыток в минуту с одного адреса
   */
  constructor(o = {}) {
    this.ttlMs = o.ttlMs ?? 10 * 60_000;
    this.hostGraceMs = o.hostGraceMs ?? 15_000;
    this.maxRooms = o.maxRooms ?? 5000;
    this.limits = { create: 10, join: 20, badJoin: 8, ...(o.limits ?? {}) };
    this.limiter = o.limiter ?? new RateLimiter();
    this.rand = o.rand ?? randomInt;
    this.rooms = new Map();
  }

  get size() { return this.rooms.size; }

  _err(conn, code, message) { conn.send({ t: 'error', code, message }); }

  _destroy(room, code, message, except) {
    if (room.dead) return;
    room.dead = true;
    clearTimeout(room.ttlTimer);
    clearTimeout(room.graceTimer);
    this.rooms.delete(room.code);
    for (const c of [room.host, room.guest]) {
      if (!c) continue;
      c.room = null;
      if (c === except) continue;
      if (code) c.send(code === 'peer-left' ? { t: 'peer-left' } : { t: 'error', code, message });
      c.close();
    }
  }

  /** Сообщение от соединения. Неизвестные и некорректные сообщения не роняют релей. */
  handle(conn, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this._err(conn, 'bad-message', 'Некорректное сообщение');
    switch (msg.t) {
      case 'create': return this._create(conn, msg);
      case 'resume': return this._resume(conn, msg);
      case 'join': return this._join(conn, msg);
      case 'offer': return this._relay(conn, msg, 'host', 'guest');
      case 'answer': return this._relay(conn, msg, 'guest', 'host');
      case 'close': return this._close(conn, msg);
      default: return this._err(conn, 'bad-message', 'Неизвестный тип сообщения');
    }
  }

  _protoOk(p) { return Number.isInteger(p) && p >= MIN_PROTO && p <= MAX_PROTO; }

  _create(conn, msg) {
    if (conn.room) return this._err(conn, 'bad-message', 'Уже в комнате');
    if (!this.limiter.allow(`create:${conn.ip}`, this.limits.create, 60_000)) return this._err(conn, 'rate-limit', 'Слишком много попыток');
    if (!this._protoOk(msg.proto)) return this._err(conn, 'version', 'Версия протокола не поддерживается');
    if (this.rooms.size >= this.maxRooms) return this._err(conn, 'busy', 'Релей перегружен');
    let code;
    for (let i = 0; i < 20; i++) { const c = generateCode(this.rand); if (!this.rooms.has(c)) { code = c; break; } }
    if (!code) return this._err(conn, 'busy', 'Не удалось выдать код');
    const room = {
      code, hostToken: randomBytes(16).toString('hex'), hostName: cleanName(msg.name), proto: msg.proto, app: String(msg.app ?? '').slice(0, 20),
      host: conn, guest: null, expiresAt: Date.now() + this.ttlMs, dead: false
    };
    room.ttlTimer = setTimeout(() => this._destroy(room, 'expired', 'Код истёк'), this.ttlMs);
    room.ttlTimer.unref?.();
    conn.room = room; conn.role = 'host';
    this.rooms.set(code, room);
    conn.send({ t: 'created', code, hostToken: room.hostToken, ttlMs: this.ttlMs, expiresAt: room.expiresAt });
  }

  _resume(conn, msg) {
    if (conn.room) return this._err(conn, 'bad-message', 'Уже в комнате');
    if (!this.limiter.allow(`join:${conn.ip}`, this.limits.join, 60_000)) return this._err(conn, 'rate-limit', 'Слишком много попыток');
    const code = normalizeCode(msg.code);
    const room = code && this.rooms.get(code);
    if (!room || !eqToken(room.hostToken, msg.hostToken)) {
      this.limiter.record(`bad:${conn.ip}`);
      return this._err(conn, 'bad-code', 'Комната не найдена');
    }
    clearTimeout(room.graceTimer);
    if (room.host && room.host !== conn) { room.host.room = null; room.host.close(); }
    room.host = conn; conn.room = room; conn.role = 'host';
    conn.send({ t: 'resumed', code, expiresAt: room.expiresAt, guest: room.guest ? { name: room.guestName } : null });
  }

  _join(conn, msg) {
    if (conn.room) return this._err(conn, 'bad-message', 'Уже в комнате');
    if (!this.limiter.allow(`join:${conn.ip}`, this.limits.join, 60_000)) return this._err(conn, 'rate-limit', 'Слишком много попыток');
    // перебор кодов: после нескольких неудач с одного адреса отвечаем отказом, даже не глядя на код
    if (this.limiter.count(`bad:${conn.ip}`, 60_000) >= this.limits.badJoin) return this._err(conn, 'rate-limit', 'Слишком много неверных кодов');
    const code = normalizeCode(msg.code);
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) {
      this.limiter.record(`bad:${conn.ip}`);
      return this._err(conn, 'bad-code', 'Неверный или просроченный код');
    }
    if (room.guest) return this._err(conn, 'room-full', 'Комната занята');
    if (!this._protoOk(msg.proto) || msg.proto !== room.proto) return this._err(conn, 'version', 'Версии приложения несовместимы');
    room.guest = conn; room.guestName = cleanName(msg.name); conn.room = room; conn.role = 'guest';
    room.host?.send({ t: 'peer', role: 'guest', name: room.guestName, proto: msg.proto, app: String(msg.app ?? '').slice(0, 20) });
    conn.send({ t: 'joined', hostName: room.hostName, proto: room.proto, app: room.app });
  }

  _relay(conn, msg, from, to) {
    const room = conn.room;
    if (!room || conn.role !== from) return this._err(conn, 'bad-message', 'Сейчас так нельзя');
    if (typeof msg.sdp !== 'string' || !msg.sdp) return this._err(conn, 'bad-message', 'Нет SDP');
    if (msg.sdp.length > MAX_SDP || Buffer.byteLength(msg.sdp) > MAX_SDP) return this._err(conn, 'too-large', 'SDP слишком большой');
    const target = room[to];
    if (!target) return this._err(conn, 'bad-message', 'Второго участника ещё нет');
    target.send({ t: msg.t, sdp: msg.sdp });
    if (msg.t === 'answer') {
      // обмен закончен: комната больше не нужна, код сгорает
      room.dead = true;
      clearTimeout(room.ttlTimer); clearTimeout(room.graceTimer);
      this.rooms.delete(room.code);
      for (const c of [room.host, room.guest]) if (c) { c.room = null; c.done = true; }
      setTimeout(() => { room.host?.close(); room.guest?.close(); }, 200).unref?.();
    }
  }

  _close(conn, msg) {
    const code = normalizeCode(msg.code) ?? conn.room?.code;
    const room = code ? this.rooms.get(code) : null;
    if (!room) return;
    const owner = conn.room === room && conn.role === 'host';
    if (!owner && !eqToken(room.hostToken, msg.hostToken)) return this._err(conn, 'forbidden', 'Нет прав закрыть комнату');
    this._destroy(room, 'peer-left', undefined, conn);
    conn.close();
  }

  /** Соединение оборвалось. */
  disconnect(conn) {
    const room = conn.room;
    if (!room || room.dead) return;
    if (conn.role === 'guest') {
      // одна попытка на код: после ухода гостя комната закрывается
      room.guest = null;
      this._destroy(room, 'peer-left', undefined, conn);
      return;
    }
    if (room.host !== conn) return;
    room.host = null;
    if (!room.guest) {
      // хост мог просто потерять сеть: ждём его возвращения
      room.graceTimer = setTimeout(() => this._destroy(room), this.hostGraceMs);
      room.graceTimer.unref?.();
    } else {
      room.graceTimer = setTimeout(() => this._destroy(room, 'peer-left'), this.hostGraceMs);
      room.graceTimer.unref?.();
    }
  }

  shutdown() {
    for (const room of [...this.rooms.values()]) this._destroy(room, 'error', 'Релей остановлен');
  }
}
