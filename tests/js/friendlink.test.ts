import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush, FakeNet, until } from './helpers/fakes';
import { generateIdentityKey, profileIdFor, signText } from '../../src/social/crypto';
import { FriendLink, type FriendIdentity, type FriendStoreApi } from '../../src/social/friendlink';
import { buildStats, periodFor } from '../../src/social/leaderboard';
import { randomNonce, signSnapshot, type LeaderboardSnapshot } from '../../src/social/snapshot';
import { defaultPermissions, type Friend } from '../../src/social/types';
import { Reassembler, splitMessage } from '../../src/social/chunking';
import { parseFriendWire } from '../../src/social/friendwire';
import type { Exercise, Workout } from '../../src/domain/types';

afterEach(() => { vi.useRealTimers(); });

const EX = [{ id: 'seed-001', name: 'Жим лёжа', muscle: 'chest', equipment: 'штанга', custom: false }] as unknown as Exercise[];
const NOW = new Date('2026-10-28T12:00:00');

async function person(name: string, volume = 500, opts: { signAs?: Awaited<ReturnType<typeof generateIdentityKey>> } = {}) {
  const key = await generateIdentityKey();
  const profileId = await profileIdFor(key.publicKey);
  const friends = new Map<string, Friend>();
  const saved = new Map<string, LeaderboardSnapshot[]>();
  const w = { id: 'w', date: '2026-10-27', status: 'done', title: 'T', exercises: [{ id: 'e', exerciseId: 'seed-001', sets: [{ id: 's', weight: volume / 5, reps: 5, done: true }] }], updatedAt: 1, deviceId: 'd' } as unknown as Workout;
  const identity: FriendIdentity = { profileId, publicKey: key.publicKey, displayName: name, sign: (t) => signText(key, t) };
  const api: FriendStoreApi = {
    identity: async () => identity,
    getFriend: async (id) => friends.get(id),
    addFriend: async (c) => { friends.set(c.profileId, { profileId: c.profileId, publicKey: c.publicKey, displayName: c.displayName, status: 'accepted', addedAt: 1, permissions: defaultPermissions() }); },
    touchFriend: async (c) => { const f = friends.get(c.profileId); if (f) friends.set(c.profileId, { ...f, displayName: c.displayName }); },
    mySnapshots: async () => {
      const signer = opts.signAs ?? key;
      const out: LeaderboardSnapshot[] = [];
      for (const kind of ['week', '4weeks', 'all'] as const) {
        const period = periodFor(kind, NOW);
        out.push(await signSnapshot({ v: 1, profileId, displayName: name, publicKey: key.publicKey, period, generatedAt: NOW.getTime(), nonce: randomNonce(), ...buildStats([w], EX, period) }, signer));
      }
      return out;
    },
    saveSnapshots: async (id, snaps) => { saved.set(id, snaps); return snaps.length; }
  };
  return { identity, api, friends, saved };
}

type P = Awaited<ReturnType<typeof person>>;
function link(net: FakeNet, p: P | null, now = () => NOW.getTime()) {
  const store: FriendStoreApi = p ? p.api : { ...(null as unknown as FriendStoreApi), identity: async () => null };
  return new FriendLink({ signaling: net.signaling, peer: net.peer, relayUrl: 'wss://relay.test', store, now });
}

async function pairUp(a: P, b: P, net = new FakeNet()) {
  const host = link(net, a), guest = link(net, b);
  await host.invite();
  await until(() => host.getState().phase === 'waiting');
  await guest.join(host.getState().code!);
  return { net, host, guest };
}

describe('друзья: добавление по коду', () => {
  it('новые люди: сверка кода и отпечатка, подтверждение обеими сторонами, обмен подписанными снимками', async () => {
    const a = await person('Дима', 500), b = await person('Аня', 800);
    const { host, guest } = await pairUp(a, b);
    await until(() => host.getState().phase === 'confirm' && guest.getState().phase === 'confirm');
    expect(host.getState().sas).toMatch(/^\d{6}$/);
    expect(host.getState().sas).toBe(guest.getState().sas);
    expect(host.getState().peer).toMatchObject({ displayName: 'Аня', profileId: b.identity.profileId, publicKey: b.identity.publicKey });
    expect(guest.getState().peer).toMatchObject({ displayName: 'Дима' });
    expect(host.getState().known).toBe(false);

    host.confirm();
    await flush();
    expect(host.getState().phase).toBe('confirm'); // ждём вторую сторону
    expect(a.friends.size).toBe(0);               // пока никто не добавлен
    guest.confirm();
    await until(() => host.getState().phase === 'done' && guest.getState().phase === 'done');
    expect(host.getState().result).toMatchObject({ added: true, received: 3, rejected: 0 });
    expect(a.friends.get(b.identity.profileId)).toMatchObject({ status: 'accepted', permissions: { leaderboard: true, workoutDetails: false } });
    expect(b.friends.get(a.identity.profileId)).toMatchObject({ displayName: 'Дима' });
    expect(a.saved.get(b.identity.profileId)!.map((s) => s.totals.volumeKg)).toEqual([800, 800, 800]);
    expect(b.saved.get(a.identity.profileId)![0].displayName).toBe('Дима');
  });

  it('отказ одной стороны: никто не добавлен, ничего не обменяно', async () => {
    const a = await person('Дима'), b = await person('Аня');
    const { host, guest } = await pairUp(a, b);
    await until(() => host.getState().phase === 'confirm' && guest.getState().phase === 'confirm');
    host.confirm();
    guest.decline();
    await until(() => host.getState().phase === 'closed');
    expect(host.getState().reason).toBe('declined');
    expect(guest.getState().reason).toBe('declined');
    expect(a.friends.size + b.friends.size + a.saved.size + b.saved.size).toBe(0);
  });

  it('повторная встреча: подтверждение не нужно, снимки обновляются сами', async () => {
    const a = await person('Дима', 500), b = await person('Аня', 800);
    const first = await pairUp(a, b);
    await until(() => first.host.getState().phase === 'confirm');
    first.host.confirm(); first.guest.confirm();
    await until(() => first.host.getState().phase === 'done' && first.guest.getState().phase === 'done');
    a.saved.clear(); b.saved.clear();

    const second = await pairUp(a, b);
    await until(() => second.host.getState().phase === 'done' && second.guest.getState().phase === 'done');
    expect(second.host.getState().known).toBe(true);
    expect(second.host.getState().result).toMatchObject({ added: false, received: 3 });
    expect(a.saved.size).toBe(1);
  });

  it('разрешение на рейтинг выключено: другу уходит пустой пакет', async () => {
    const a = await person('Дима'), b = await person('Аня');
    const first = await pairUp(a, b);
    await until(() => first.host.getState().phase === 'confirm');
    first.host.confirm(); first.guest.confirm();
    await until(() => first.host.getState().phase === 'done');
    a.friends.set(b.identity.profileId, { ...a.friends.get(b.identity.profileId)!, permissions: { leaderboard: false, workoutDetails: false } });
    b.saved.clear();
    const second = await pairUp(a, b);
    await until(() => second.host.getState().phase === 'done' && second.guest.getState().phase === 'done');
    expect(b.saved.size).toBe(0);                       // Аня ничего не получила от Димы
    expect(second.guest.getState().result!.received).toBe(0);
    expect(second.host.getState().result!.received).toBe(3); // а Дима от Ани получил
  });

  it('заблокированный не соединяется: он видит отказ, мы — причину', async () => {
    const a = await person('Дима'), b = await person('Аня');
    a.friends.set(b.identity.profileId, { profileId: b.identity.profileId, publicKey: b.identity.publicKey, displayName: 'Аня', status: 'blocked', addedAt: 1, permissions: { leaderboard: false, workoutDetails: false } });
    const { host, guest } = await pairUp(a, b);
    await until(() => host.getState().phase === 'closed' && guest.getState().phase === 'closed');
    expect(host.getState().reason).toBe('blocked');
    expect(guest.getState().reason).toBe('declined');
    expect(a.saved.size + b.saved.size).toBe(0);
  });

  it('у знакомого профиля другой ключ: предупреждение, а не молчаливое доверие', async () => {
    const a = await person('Дима'), b = await person('Аня');
    const other = await generateIdentityKey();
    a.friends.set(b.identity.profileId, { profileId: b.identity.profileId, publicKey: other.publicKey, displayName: 'Аня', status: 'accepted', addedAt: 1, permissions: defaultPermissions() });
    const { host } = await pairUp(a, b);
    await until(() => host.getState().phase === 'closed');
    expect(host.getState().reason).toBe('key-changed');
  });

  it('своё приглашение: «это вы»', async () => {
    const a = await person('Дима');
    const { host, guest } = await pairUp(a, a);
    await until(() => host.getState().phase === 'closed' && guest.getState().phase === 'closed');
    expect(host.getState().reason).toBe('self');
  });

  it('без профиля создать приглашение нельзя', async () => {
    const l = link(new FakeNet(), null);
    await l.invite();
    expect(l.getState()).toMatchObject({ phase: 'closed', reason: 'no-profile' });
  });

  it('подмена канала на релее: подпись не подходит, друг не добавляется', async () => {
    const a = await person('Дима'), b = await person('Аня');
    const net = new FakeNet();
    net.tamper = true;
    const { host, guest } = await pairUp(a, b, net);
    await until(() => host.getState().phase === 'closed' || guest.getState().phase === 'closed');
    expect([host.getState().reason, guest.getState().reason]).toContain('bad-auth');
    expect(a.friends.size + b.friends.size).toBe(0);
  });

  it('чужая подпись в снимках: пакет отклоняется целиком', async () => {
    const a = await person('Дима');
    const impostorKey = await generateIdentityKey();
    const b = await person('Аня', 800, { signAs: impostorKey });
    const { host, guest } = await pairUp(a, b);
    await until(() => host.getState().phase === 'confirm' && guest.getState().phase === 'confirm');
    host.confirm(); guest.confirm();
    await until(() => host.getState().phase === 'done' && guest.getState().phase === 'done');
    expect(host.getState().result).toMatchObject({ received: 0, rejected: 3 });
    expect(a.saved.size).toBe(0);
  });

  it('код сгорел или неверный: понятная причина', async () => {
    const b = await person('Аня');
    const g = link(new FakeNet(), b);
    await g.join('ZZZZ-ZZZZ');
    await until(() => g.getState().phase === 'closed');
    expect(g.getState().reason).toBe('bad-code');
    await g.join('abc');
    expect(g.getState().reason).toBe('bad-code');
  });

  it('отмена и повторный запуск', async () => {
    const a = await person('Дима');
    const net = new FakeNet();
    const l = link(net, a);
    await l.invite();
    await until(() => l.getState().phase === 'waiting');
    l.cancel();
    await flush();
    expect(l.getState().phase).toBe('idle');
    expect(net.store.size).toBe(0);
    await l.invite();
    await until(() => l.getState().phase === 'waiting');
  });

  it('мусор в канале игнорируется', async () => {
    const a = await person('Дима'), b = await person('Аня');
    const { net, host, guest } = await pairUp(a, b);
    await until(() => host.getState().phase === 'confirm' && guest.getState().phase === 'confirm');
    for (const junk of ['x', '{}', '{"k":"part"}', '{"k":"auth","sig":"short"}', '{"k":"confirm","x":1}'.replace('confirm', 'nope'), '[]']) net.host().deliver(junk);
    await flush();
    expect(host.getState().phase).toBe('confirm');
  });

  it('преждевременное «confirm» без проверки личности не запускает обмен', async () => {
    const a = await person('Дима'), b = await person('Аня');
    const net = new FakeNet();
    const host = link(net, a);
    await host.invite();
    await until(() => host.getState().phase === 'waiting');
    const guest = link(net, b);
    await guest.join(host.getState().code!);
    await until(() => host.getState().phase === 'connecting' || host.getState().phase === 'verifying' || host.getState().phase === 'confirm');
    net.host().deliver('{"k":"confirm"}');
    net.host().deliver(JSON.stringify({ k: 'part', part: { id: 'a', i: 0, n: 1, data: '{"snapshots":[]}' } }));
    await flush();
    expect(a.saved.size).toBe(0);
    expect(host.getState().phase).not.toBe('done');
  });
});

describe('куски и разбор сообщений', () => {
  it('разрезание и сборка', () => {
    const text = 'я'.repeat(30_000);
    const parts = splitMessage('id1', text);
    expect(parts.length).toBe(3);
    const r = new Reassembler();
    expect(r.push(parts[0])).toBeNull();
    expect(r.push(parts[1])).toBeNull();
    expect(r.push(parts[2])).toBe(text);
    expect(splitMessage('x', '').length).toBe(1);
  });

  it('нарушения порядка, чужие куски и огромные сообщения отвергаются', () => {
    const parts = splitMessage('id1', 'a'.repeat(30_000));
    const r = new Reassembler();
    expect(r.push(parts[1])).toBe('bad');                         // начало не с нуля
    expect(new Reassembler().push({ ...parts[0], n: 999 })).toBe('bad');
    const r2 = new Reassembler();
    r2.push(parts[0]);
    expect(r2.push({ ...parts[1], id: 'другой' })).toBe('bad');
    const r3 = new Reassembler();
    let last: unknown = null;
    for (let i = 0; i < 40; i++) last = r3.push({ id: 'big', i, n: 40, data: 'x'.repeat(12_000) });
    expect(last).toBe('bad');                                      // больше 400 000 знаков
  });

  it('разбор сообщений друга: строго', () => {
    expect(parseFriendWire('{"k":"confirm","лишнее":1}')).toEqual({ k: 'confirm' });
    expect(parseFriendWire('{"k":"bye","reason":"done"}')).toEqual({ k: 'bye', reason: 'done' });
    for (const bad of ['', 'x', '[]', '{"k":"hello"}', '{"k":"hello","v":1,"nonce":"abcdefgh","card":{"profileId":"x","publicKey":"y","displayName":"z"}}', '{"k":"part","part":{"id":"a","i":"0","n":1,"data":"x"}}', '{"k":"auth","sig":""}', 'x'.repeat(30_000)]) expect(parseFriendWire(bad), bad.slice(0, 40)).toBeNull();
  });
});
