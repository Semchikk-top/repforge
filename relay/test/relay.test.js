import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createRelay } from '../src/server.js';
import { ALPHABET, generateCode, normalizeCode, RateLimiter } from '../src/rooms.js';

const ORIGIN = 'https://app.example';

async function start(opts = {}) {
  const relay = createRelay({ origins: [ORIGIN], allowLocalhost: false, ...opts });
  const port = await relay.listen(0);
  return { relay, url: `ws://127.0.0.1:${port}` };
}

function client(url, origin = ORIGIN) {
  const ws = new WebSocket(url, { origin });
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const w = waiters.shift();
    if (w) w(m); else queue.push(m);
  });
  const closed = new Promise((r) => ws.on('close', r));
  const opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return {
    ws, opened, closed,
    send: (o) => ws.send(JSON.stringify(o)),
    next: (ms = 1500) => new Promise((res, rej) => {
      const m = queue.shift();
      if (m) return res(m);
      const t = setTimeout(() => rej(new Error('нет сообщения за ' + ms + ' мс')), ms);
      waiters.push((x) => { clearTimeout(t); res(x); });
    }),
    close: () => ws.close()
  };
}

const create = async (url, name = 'Дима', extra = {}) => {
  const c = client(url); await c.opened;
  c.send({ t: 'create', name, proto: 1, app: '0.4.0', ...extra });
  return { c, msg: await c.next() };
};

test('код: алфавит без похожих символов, формат XXXX-XXXX, нормализация', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(![...code.replace('-', '')].some((ch) => '01OI'.includes(ch)));
    assert.ok([...code.replace('-', '')].every((ch) => ALPHABET.includes(ch)));
  }
  assert.equal(normalizeCode('k7m4 p2qx'), 'K7M4-P2QX');
  assert.equal(normalizeCode('k7m4p2qx'), 'K7M4-P2QX');
  assert.equal(normalizeCode('K7M4-P2Q0'), null);
  assert.equal(normalizeCode('K7M4'), null);
  assert.equal(normalizeCode(42), null);
});

test('полный обмен: create → join → offer → answer, комната сгорает', async () => {
  const { relay, url } = await start();
  try {
    const { c: host, msg: created } = await create(url);
    assert.equal(created.t, 'created');
    assert.match(created.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(created.ttlMs, 600000);
    assert.ok(created.hostToken.length >= 32);

    const guest = client(url); await guest.opened;
    guest.send({ t: 'join', code: created.code.toLowerCase(), name: 'Аня', proto: 1, app: '0.4.0' });
    assert.deepEqual(await host.next(), { t: 'peer', role: 'guest', name: 'Аня', proto: 1, app: '0.4.0' });
    assert.deepEqual(await guest.next(), { t: 'joined', hostName: 'Дима', proto: 1, app: '0.4.0' });

    host.send({ t: 'offer', sdp: 'v=0 offer' });
    assert.deepEqual(await guest.next(), { t: 'offer', sdp: 'v=0 offer' });
    guest.send({ t: 'answer', sdp: 'v=0 answer' });
    assert.deepEqual(await host.next(), { t: 'answer', sdp: 'v=0 answer' });

    await Promise.all([host.closed, guest.closed]); // релей закрывает оба соединения
    assert.equal(relay.store.size, 0);

    const late = client(url); await late.opened;
    late.send({ t: 'join', code: created.code, name: 'Поздно', proto: 1 });
    assert.equal((await late.next()).code, 'bad-code'); // код сгорел
  } finally { await relay.close(); }
});

test('неверный код и занятая комната', async () => {
  const { relay, url } = await start();
  try {
    const { c: host, msg } = await create(url);
    const g1 = client(url); await g1.opened;
    g1.send({ t: 'join', code: 'ZZZZ-ZZZZ', name: 'x', proto: 1 });
    assert.equal((await g1.next()).code, 'bad-code');
    g1.send({ t: 'join', code: msg.code, name: 'Первый', proto: 1 });
    assert.equal((await g1.next()).t, 'joined');
    await host.next(); // peer

    const g2 = client(url); await g2.opened;
    g2.send({ t: 'join', code: msg.code, name: 'Второй', proto: 1 });
    assert.equal((await g2.next()).code, 'room-full');
  } finally { await relay.close(); }
});

test('TTL: просроченная комната закрывается, код недействителен', async () => {
  const { relay, url } = await start({ ttlMs: 150 });
  try {
    const { c: host, msg } = await create(url);
    const err = await host.next();
    assert.equal(err.code, 'expired');
    await host.closed;
    const g = client(url); await g.opened;
    g.send({ t: 'join', code: msg.code, name: 'x', proto: 1 });
    assert.equal((await g.next()).code, 'bad-code');
  } finally { await relay.close(); }
});

test('Origin: чужой сайт не подключается, свой — да, localhost — по настройке', async () => {
  const { relay, url } = await start();
  try {
    const bad = client(url, 'https://evil.example');
    await assert.rejects(bad.opened);
    const none = new WebSocket(url);
    await assert.rejects(new Promise((res, rej) => { none.on('open', res); none.on('error', rej); }));
    const ok = client(url); await ok.opened; ok.close();
  } finally { await relay.close(); }
  const dev = await start({ allowLocalhost: true });
  try {
    const l = client(dev.url, 'http://localhost:5173'); await l.opened; l.close();
  } finally { await dev.relay.close(); }
});

test('лимиты: слишком большой SDP, версия протокола, посторонний не закрывает комнату', async () => {
  const { relay, url } = await start();
  try {
    const { c: host, msg } = await create(url);
    const g = client(url); await g.opened;
    g.send({ t: 'join', code: msg.code, name: 'Аня', proto: 1 });
    await g.next(); await host.next();
    host.send({ t: 'offer', sdp: 'a'.repeat(64 * 1024 + 1) });
    assert.equal((await host.next()).code, 'too-large');

    const stranger = client(url); await stranger.opened;
    stranger.send({ t: 'close', code: msg.code, hostToken: 'nope' });
    assert.equal((await stranger.next()).code, 'forbidden');
    assert.equal(relay.store.size, 1);

    const old = client(url); await old.opened;
    old.send({ t: 'create', name: 'Старый', proto: 99 });
    assert.equal((await old.next()).code, 'version');
  } finally { await relay.close(); }
});

test('несовместимая версия гостя отклоняется', async () => {
  const { relay, url } = await start();
  try {
    const { msg } = await create(url);
    const g = client(url); await g.opened;
    g.send({ t: 'join', code: msg.code, name: 'x', proto: 2 });
    assert.equal((await g.next()).code, 'version');
  } finally { await relay.close(); }
});

test('гость вышел: хост получает peer-left, комната закрыта', async () => {
  const { relay, url } = await start();
  try {
    const { c: host, msg } = await create(url);
    const g = client(url); await g.opened;
    g.send({ t: 'join', code: msg.code, name: 'Аня', proto: 1 });
    await g.next(); await host.next();
    g.close();
    assert.deepEqual(await host.next(), { t: 'peer-left' });
    assert.equal(relay.store.size, 0);
  } finally { await relay.close(); }
});

test('хост закрыл комнату: гость получает peer-left', async () => {
  const { relay, url } = await start();
  try {
    const { c: host, msg } = await create(url);
    const g = client(url); await g.opened;
    g.send({ t: 'join', code: msg.code, name: 'Аня', proto: 1 });
    await g.next(); await host.next();
    host.send({ t: 'close', code: msg.code, hostToken: msg.hostToken });
    assert.deepEqual(await g.next(), { t: 'peer-left' });
    assert.equal(relay.store.size, 0);
  } finally { await relay.close(); }
});

test('хост потерял связь и вернулся по hostToken; чужой токен не подходит', async () => {
  const { relay, url } = await start({ hostGraceMs: 2000 });
  try {
    const { c: host, msg } = await create(url);
    host.ws.terminate();
    await host.closed;
    assert.equal(relay.store.size, 1); // комната ждёт хоста

    const thief = client(url); await thief.opened;
    thief.send({ t: 'resume', code: msg.code, hostToken: '0'.repeat(32) });
    assert.equal((await thief.next()).code, 'bad-code');

    const back = client(url); await back.opened;
    back.send({ t: 'resume', code: msg.code, hostToken: msg.hostToken });
    const r = await back.next();
    assert.equal(r.t, 'resumed');
    assert.equal(r.guest, null);

    const g = client(url); await g.opened;
    g.send({ t: 'join', code: msg.code, name: 'Аня', proto: 1 });
    assert.equal((await back.next()).t, 'peer'); // новый хост получает гостя
  } finally { await relay.close(); }
});

test('хост не вернулся за отведённое время: комната удаляется', async () => {
  const { relay, url } = await start({ hostGraceMs: 100 });
  try {
    const { c: host } = await create(url);
    host.ws.terminate();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(relay.store.size, 0);
  } finally { await relay.close(); }
});

test('rate limit: создание и перебор кодов с одного адреса', async () => {
  const { relay, url } = await start({ limits: { create: 3, join: 50, badJoin: 4 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await create(url)).msg.t, 'created');
    assert.equal((await create(url)).msg.code, 'rate-limit');

    const g = client(url); await g.opened;
    for (let i = 0; i < 4; i++) { g.send({ t: 'join', code: 'AAAA-AAAA', name: 'x', proto: 1 }); assert.equal((await g.next()).code, 'bad-code'); }
    g.send({ t: 'join', code: 'AAAA-AAAA', name: 'x', proto: 1 });
    assert.equal((await g.next()).code, 'rate-limit');
  } finally { await relay.close(); }
});

test('мусор не роняет релей', async () => {
  const { relay, url } = await start();
  try {
    const c = client(url); await c.opened;
    c.ws.send('это не JSON');
    assert.equal((await c.next()).code, 'bad-message');
    c.send({ t: 'что-то' });
    assert.equal((await c.next()).code, 'bad-message');
    c.send({ t: 'offer', sdp: 'x' }); // не в комнате
    assert.equal((await c.next()).code, 'bad-message');
    c.ws.send(Buffer.from([1, 2, 3]));
    assert.equal((await c.next()).code, 'bad-message');
  } finally { await relay.close(); }
});

test('RateLimiter: окно скользит', () => {
  let t = 0;
  const rl = new RateLimiter(() => t);
  assert.ok(rl.allow('k', 2, 1000)); assert.ok(rl.allow('k', 2, 1000)); assert.ok(!rl.allow('k', 2, 1000));
  t = 1001;
  assert.ok(rl.allow('k', 2, 1000));
});
