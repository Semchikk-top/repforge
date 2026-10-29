import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePair, flush, until } from './helpers/fakes';
import { LIMITS } from '../../src/nearby/config';
import { REASON_TEXT, type RoomManager } from '../../src/nearby/room';
import type { Presence } from '../../src/nearby/presence';

const realSetTimeout = setTimeout; // настоящий таймер: проверки подписей идут вне фейковых часов
afterEach(() => { vi.useRealTimers(); });

/** Двигает фейковые часы по чуть-чуть, давая настоящим асинхронным операциям (crypto) завершиться. */
async function settleUntil(cond: () => boolean, maxSteps = 200) {
  for (let i = 0; i < maxSteps && !cond(); i++) {
    await vi.advanceTimersByTimeAsync(20);
    await new Promise<void>((r) => realSetTimeout(r, 2));
  }
}

const pres = (over: Partial<Presence> = {}): Presence => ({ v: 1, phase: 'working', exerciseName: 'Жим лёжа', setIndex: 2, setTotal: 4, updatedAt: 1, ...over });

/** Хост создаёт комнату, гость входит по коду; ждём экрана сверки на обеих сторонах. */
async function connect() {
  const t = makePair();
  t.host.createRoom('Дима', true);
  await until(() => t.host.getState().phase === 'waiting');
  const code = t.host.getState().code!;
  t.guest.joinRoom(code, 'Аня');
  await until(() => t.host.getState().phase === 'approval' && t.guest.getState().phase === 'awaiting');
  return { ...t, code };
}

/** То же на фейковых часах: для проверок таймеров. Вызывать после vi.useFakeTimers(). */
async function connectFake(approve = false, now?: () => number) {
  const t = makePair({ now });
  t.host.createRoom('Дима', true);
  await settleUntil(() => t.host.getState().phase === 'waiting');
  t.guest.joinRoom(t.host.getState().code!, 'Аня');
  await settleUntil(() => t.host.getState().phase === 'approval' && t.guest.getState().phase === 'awaiting');
  if (approve) { t.host.approve(); await settleUntil(() => t.guest.getState().phase === 'active' && t.host.getState().phase === 'active'); }
  return t;
}

async function active() {
  const t = await connect();
  t.host.approve();
  await until(() => t.guest.getState().phase === 'active');
  return t;
}

describe('комната: подключение', () => {
  it('код → запрос входа с одинаковым кодом сверки → разрешение → чат', async () => {
    const { host, guest, code } = await connect();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(host.getState().sas).toMatch(/^\d{6}$/);
    expect(host.getState().sas).toBe(guest.getState().sas);
    // имена приходят по защищённому каналу
    expect(host.getState().peerName).toBe('Аня');
    expect(guest.getState().peerName).toBe('Дима');
    host.approve();
    await until(() => host.getState().phase === 'active' && guest.getState().phase === 'active');
  });

  it('первое сообщение гостя потерялось: hello повторяется, и сверка всё равно наступает', async () => {
    const t = makePair();
    t.net.dropFirstFromGuest = 2;
    t.host.createRoom('Дима', true);
    await until(() => t.host.getState().phase === 'waiting');
    t.guest.joinRoom(t.host.getState().code!, 'Аня');
    await until(() => t.host.getState().phase === 'approval' && t.guest.getState().phase === 'awaiting', 4000);
    expect(t.host.getState().peerName).toBe('Аня');
  });

  it('хост получает событие approval с именем гостя', async () => {
    const t = makePair();
    const seen: string[] = [];
    t.host.onEvent((e) => { if (e.type === 'approval') seen.push(e.name); });
    t.host.createRoom('Дима', true);
    await until(() => t.host.getState().phase === 'waiting');
    t.guest.joinRoom(t.host.getState().code!.toLowerCase(), 'Аня');
    await until(() => t.host.getState().phase === 'approval');
    expect(seen).toEqual(['Аня']);
  });

  it('хост отклонил: гость видит отказ, у хоста комнаты нет', async () => {
    const { host, guest } = await connect();
    host.reject();
    await until(() => guest.getState().phase === 'closed');
    expect(guest.getState().reason).toBe('rejected');
    expect(host.getState().phase).toBe('idle');
    expect(host.busy).toBe(false);
  });

  it('подмена SDP на релее: коды сверки на экранах не совпадают', async () => {
    const t = makePair();
    t.net.tamper = true;
    t.host.createRoom('Дима', true);
    await until(() => t.host.getState().phase === 'waiting');
    t.guest.joinRoom(t.host.getState().code!, 'Аня');
    await until(() => t.host.getState().phase === 'approval' && t.guest.getState().phase === 'awaiting');
    expect(t.host.getState().sas).not.toBe(t.guest.getState().sas);
  });

  it('неверный код: сначала по формату, потом по ответу релея', async () => {
    const t = makePair();
    t.guest.joinRoom('abc', 'Аня');
    expect(t.guest.getState()).toMatchObject({ phase: 'closed', reason: 'bad-code' });
    t.guest.dismiss();
    expect(t.guest.getState().phase).toBe('idle');
    t.guest.joinRoom('ZZZZ-ZZZZ', 'Аня');
    await until(() => t.guest.getState().phase === 'closed');
    expect(t.guest.getState().reason).toBe('bad-code');
    expect(REASON_TEXT['bad-code']).toMatch(/просроченный/);
  });

  it('комната занята: второй гость не входит, первая пара не страдает', async () => {
    const t = makePair();
    const { RoomManager } = await import('../../src/nearby/room');
    const second = new RoomManager({ signaling: t.net.signaling, peer: t.net.peer, relayUrl: 'wss://relay.test' });
    t.host.createRoom('Дима', true);
    await until(() => t.host.getState().phase === 'waiting');
    const code = t.host.getState().code!;
    t.guest.joinRoom(code, 'Первый');
    second.joinRoom(code, 'Второй'); // сразу следом, пока обмен SDP не закончился и код не сгорел
    await until(() => second.getState().phase === 'closed');
    expect(second.getState().reason).toBe('room-full');
    await until(() => t.host.getState().phase === 'approval' && t.guest.getState().phase === 'awaiting');
  });

  it('код сгорает после обмена: опоздавший видит «неверный или просроченный код»', async () => {
    const { code, net } = await connect();
    const { RoomManager } = await import('../../src/nearby/room');
    const late = new RoomManager({ signaling: net.signaling, peer: net.peer, relayUrl: 'wss://relay.test' });
    late.joinRoom(code, 'Опоздавший');
    await until(() => late.getState().phase === 'closed');
    expect(late.getState().reason).toBe('bad-code');
  });

  it('релей не задан в сборке: честная причина, соединения не создаются', () => {
    const t = makePair({ relayUrl: '' });
    t.host.createRoom('Дима', true);
    expect(t.host.getState()).toMatchObject({ phase: 'closed', reason: 'no-relay' });
    expect(t.net.peers).toHaveLength(0);
  });

  it('повторное «Создать» во время комнаты ничего не ломает', async () => {
    const t = makePair();
    t.host.createRoom('Дима', true);
    t.host.createRoom('Дима', true);
    await until(() => t.host.getState().phase === 'waiting');
    expect(t.net.peers).toHaveLength(1);
  });

  it('прямой канал не пробился: через 20 секунд «не удалось соединиться»', async () => {
    const t = makePair();
    t.net.mode = 'never';
    t.host.createRoom('Дима', true);
    await until(() => t.host.getState().phase === 'waiting');
    vi.useFakeTimers();
    t.guest.joinRoom(t.host.getState().code!, 'Аня');
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(t.host.getState().phase).toBe('connecting');
    await vi.advanceTimersByTimeAsync(LIMITS.connectMs + 100);
    expect(t.host.getState()).toMatchObject({ phase: 'closed', reason: 'ice-failed' });
    expect(t.guest.getState()).toMatchObject({ phase: 'closed', reason: 'ice-failed' });
    expect(REASON_TEXT['ice-failed']).toMatch(/хотспот/);
  });

  it('код живёт 10 минут: потом «код истёк», комната на релее удалена', async () => {
    vi.useFakeTimers();
    const t = makePair();
    t.host.createRoom('Дима', true);
    await vi.advanceTimersByTimeAsync(50);
    expect(t.host.getState().phase).toBe('waiting');
    expect(t.net.store.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 100);
    expect(t.host.getState()).toMatchObject({ phase: 'closed', reason: 'expired' });
    expect(t.net.store.size).toBe(0);
  });

  it('хост отменил ожидание: комната на релее закрыта', async () => {
    const t = makePair();
    t.host.createRoom('Дима', true);
    await until(() => t.host.getState().phase === 'waiting');
    t.host.leave();
    await flush();
    expect(t.host.getState().phase).toBe('idle');
    expect(t.net.store.size).toBe(0);
  });

  it('хост не ответил на запрос входа 3 минуты: оба видят таймаут', async () => {
    vi.useFakeTimers();
    const t = await connectFake();
    expect(t.host.getState().phase).toBe('approval');
    await vi.advanceTimersByTimeAsync(LIMITS.approvalMs + 500);
    expect(t.host.getState()).toMatchObject({ phase: 'closed', reason: 'timeout' });
    expect(t.guest.getState()).toMatchObject({ phase: 'closed', reason: 'peer-left' });
  });
});

describe('комната: общение', () => {
  it('сообщения идут в обе стороны, счётчик непрочитанных работает', async () => {
    const { host, guest } = await active();
    host.setViewing(true);
    expect(guest.sendChat('  Ты   где?  ')).toBe(true);
    await until(() => host.getState().messages.length === 1);
    expect(host.getState().messages[0]).toMatchObject({ from: 'peer', text: 'Ты где?' });
    expect(host.getState().unread).toBe(0); // экран открыт

    host.setViewing(false);
    guest.sendChat('Я на жиме');
    guest.sendChat('Иди сюда');
    await until(() => host.getState().unread === 2);
    host.setViewing(true);
    expect(host.getState().unread).toBe(0);
    expect(guest.getState().messages).toHaveLength(3);
    expect(guest.getState().messages.every((m) => m.from === 'me')).toBe(true);
  });

  it('пустое и слишком длинное: пустое не уходит, длинное обрезается до 300', async () => {
    const { host, guest } = await active();
    expect(host.sendChat('   ')).toBe(false);
    host.sendChat('я'.repeat(500));
    await until(() => guest.getState().messages.length === 1);
    expect(guest.getState().messages[0].text).toHaveLength(300);
  });

  it('«Подстрахуй» дополняется упражнением, если человек его не скрывает', async () => {
    const { host, guest } = await active();
    host.updateLocalPresence(pres());
    host.sendQuick('spot');
    await until(() => guest.getState().messages.length === 1);
    expect(guest.getState().messages[0].text).toBe('Подстрахуй: Жим лёжа');
    host.sendQuick('coming');
    await until(() => guest.getState().messages.length === 2);
    expect(guest.getState().messages[1].text).toBe('Иду');

    host.updateLocalPresence({ v: 1, phase: 'idle', hidden: true, updatedAt: 2 });
    host.sendQuick('spot');
    await until(() => guest.getState().messages.length === 3);
    expect(guest.getState().messages[2].text).toBe('Подстрахуй');
  });

  it('«Позвать»: событие у друга, повтор чаще 5 секунд блокируется', async () => {
    const { host, guest } = await active();
    let calls = 0;
    guest.onEvent((e) => { if (e.type === 'call') calls++; });
    expect(host.call()).toBe(true);
    expect(host.call()).toBe(false);
    await until(() => calls === 1);
    expect(guest.getState().messages.at(-1)).toMatchObject({ kind: 'call', from: 'peer' });
    expect(host.getState().messages.at(-1)).toMatchObject({ kind: 'call', from: 'me' });
  });

  it('вызовы чаще раза в 3 секунды у получателя не накапливаются', async () => {
    const { host, guest, net } = await active();
    let calls = 0;
    guest.onEvent((e) => { if (e.type === 'call') calls++; });
    for (let i = 0; i < 5; i++) net.guest().deliver(JSON.stringify({ k: 'call' }));
    expect(calls).toBe(1);
    expect(host.getState().phase).toBe('active');
  });

  it('presence: приходит при входе и при смене, но не от скрытого', async () => {
    const { host, guest } = await active();
    host.updateLocalPresence(pres({ phase: 'resting', restRemainingSec: 90, restTotalSec: 90 }));
    await until(() => guest.getState().remote?.p.phase === 'resting');
    expect(guest.getState().remote!.p).toMatchObject({ exerciseName: 'Жим лёжа', setIndex: 2, setTotal: 4, restRemainingSec: 90 });

    const before = host.getState().messages.length;
    host.updateLocalPresence({ v: 1, phase: 'idle', hidden: true, updatedAt: 5 });
    await until(() => guest.getState().remote?.p.hidden === true);
    expect(guest.getState().remote!.p.exerciseName).toBeUndefined();
    expect(host.getState().messages.length).toBe(before); // presence не попадает в чат
  });

  it('presence не шлётся повторно без изменений, пока не пришёл heartbeat', async () => {
    const { host, net } = await active();
    host.updateLocalPresence(pres());
    const n = () => net.host().sent.filter((s) => s.includes('"presence"')).length;
    const first = n();
    host.updateLocalPresence(pres({ updatedAt: 99 }));
    host.updateLocalPresence(pres({ updatedAt: 100 }));
    expect(n()).toBe(first);
    host.updateLocalPresence(pres({ setIndex: 3 }));
    expect(n()).toBe(first + 1);
  });

  it('до подтверждения чат и presence не принимаются, после — принимаются', async () => {
    const { host, net } = await connect();
    net.guest().sent.length = 0;
    net.host().deliver(JSON.stringify({ k: 'chat', text: 'раньше времени' }));
    net.host().deliver(JSON.stringify({ k: 'presence', p: pres() }));
    net.host().deliver(JSON.stringify({ k: 'call' }));
    expect(host.getState().messages).toHaveLength(0);
    expect(host.getState().remote).toBeNull();
    host.approve();
    net.host().deliver(JSON.stringify({ k: 'chat', text: 'теперь можно' }));
    expect(host.getState().messages).toHaveLength(1);
  });

  it('мусор и чужие поля отбрасываются, комната не падает', async () => {
    const { host, net } = await active();
    const p = net.host();
    p.deliver('не json');
    p.deliver('{"k":"unknown"}');
    p.deliver('[1,2]');
    p.deliver(JSON.stringify({ k: 'chat', text: 5 }));
    p.deliver(JSON.stringify({ k: 'chat', text: 'x'.repeat(5000) }));
    p.deliver(JSON.stringify({ k: 'presence', p: { v: 1, phase: 'working', exerciseName: 'Присед', weight: 200, notes: 'секрет', setIndex: 500, setTotal: 3 } }));
    expect(host.getState().phase).toBe('active');
    expect(host.getState().messages).toHaveLength(0);
    const rp = host.getState().remote!.p as unknown as Record<string, unknown>;
    expect(rp.weight).toBeUndefined();
    expect(rp.notes).toBeUndefined();
    expect(rp.setIndex).toBe(3); // не больше общего числа подходов
  });

  it('поток сообщений от друга ограничен', async () => {
    const { host, net } = await active();
    for (let i = 0; i < 50; i++) net.host().deliver(JSON.stringify({ k: 'chat', text: `m${i}` }));
    expect(host.getState().messages.length).toBe(20);
  });

  it('история ограничена сотней сообщений', async () => {
    const { host, net } = await active();
    vi.useFakeTimers();
    for (let i = 0; i < 150; i++) {
      vi.advanceTimersByTime(1000); // чтобы не сработала защита от потока
      net.host().deliver(JSON.stringify({ k: 'chat', text: `m${i}` }));
    }
    expect(host.getState().messages).toHaveLength(100);
    expect(host.getState().messages.at(-1)!.text).toBe('m149');
  });
});

describe('комната: завершение', () => {
  it('выход: друг получает «вышел», у обоих комната закрыта, сообщения стёрты', async () => {
    const { host, guest, net } = await active();
    host.sendChat('привет');
    await until(() => guest.getState().messages.length === 1);
    guest.leave();
    await until(() => host.getState().phase === 'closed');
    expect(host.getState().reason).toBe('peer-left');
    expect(host.getState().messages).toHaveLength(0);
    expect(guest.getState()).toMatchObject({ phase: 'idle', messages: [] });
    await new Promise((r) => setTimeout(r, 300));
    expect(net.peers.every((p) => p.closed)).toBe(true);
  });

  it('обрыв канала: «связь потеряна», переписка остаётся видна до закрытия, новый код — новая комната', async () => {
    const { host, net } = await active();
    host.sendChat('ты где?');
    net.cutAll();
    expect(host.getState()).toMatchObject({ phase: 'closed', reason: 'lost' });
    expect(host.getState().messages).toHaveLength(1);
    host.dismiss();
    expect(host.getState()).toMatchObject({ phase: 'idle', messages: [] });
    host.createRoom('Дима', true);
    await until(() => host.getState().phase === 'waiting');
    expect(host.getState().code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('пока друг шлёт heartbeat, связь не считается потерянной', async () => {
    vi.useFakeTimers();
    const t = await connectFake(true);
    t.host.updateLocalPresence(pres());
    t.guest.updateLocalPresence(pres());
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(t.host.getState().phase).toBe('active');
    expect(t.guest.getState().phase).toBe('active');
    expect(t.guest.getState().remote).not.toBeNull();
  });

  it('молчание друга дольше 40 секунд: потеря связи', async () => {
    vi.useFakeTimers();
    const t = await connectFake(true);
    t.net.muted = true; // канал «открыт», но сообщения не доходят
    await vi.advanceTimersByTimeAsync(LIMITS.deadAfterMs + 6000);
    expect(t.host.getState()).toMatchObject({ phase: 'closed', reason: 'lost' });
  });

  it('после сна телефона связи даётся ещё 10 секунд на восстановление', async () => {
    vi.useFakeTimers();
    const t = await connectFake(true);
    t.net.muted = true;
    // экран был выключен: часы ушли вперёд, таймеры в это время не работали
    vi.setSystemTime(Date.now() + LIMITS.deadAfterMs + 3000);
    t.host.onForeground();
    t.guest.onForeground(); // часы в тесте общие, поэтому «проснулись» оба телефона
    t.net.muted = false;
    await vi.advanceTimersByTimeAsync(5100);
    expect(t.host.getState().phase).toBe('active'); // без onForeground тут была бы потеря связи
  });

  it('несовместимая версия по каналу: «обновите приложение»', async () => {
    const t = makePair();
    t.host.createRoom('Дима', true);
    await until(() => t.host.getState().phase === 'waiting');
    t.guest.joinRoom(t.host.getState().code!, 'Аня');
    await until(() => t.host.getState().phase === 'approval');
    // вторая сессия: чужой hello с другой версией протокола
    const t2 = makePair();
    t2.host.createRoom('Дима', true);
    await until(() => t2.host.getState().phase === 'waiting');
    const orig = t2.net.peer;
    t2.net.peer = (role, h) => {
      const p = orig(role, h);
      if (role === 'guest') {
        const send = p.send.bind(p);
        p.send = (text: string) => send(text.replace('"proto":1', '"proto":2'));
      }
      return p;
    };
    const { RoomManager } = await import('../../src/nearby/room');
    const g2 = new RoomManager({ signaling: t2.net.signaling, peer: t2.net.peer, relayUrl: 'wss://relay.test' });
    g2.joinRoom(t2.host.getState().code!, 'Аня');
    await until(() => t2.host.getState().phase === 'closed');
    expect(t2.host.getState().reason).toBe('version');
    expect(REASON_TEXT.version).toMatch(/Обновите/);
  });
});

describe('менеджер: независимость от React', () => {
  it('getState возвращает один и тот же объект, пока ничего не менялось (useSyncExternalStore)', async () => {
    const { host } = await active();
    const a = host.getState();
    expect(host.getState()).toBe(a);
    host.sendChat('x');
    expect(host.getState()).not.toBe(a);
  });

  it('подписчики получают уведомления и могут отписаться', async () => {
    const t = makePair();
    const spy = vi.fn();
    const off = t.host.subscribe(spy);
    t.host.createRoom('Дима', true);
    expect(spy).toHaveBeenCalled();
    off();
    spy.mockClear();
    await until(() => t.host.getState().phase === 'waiting');
    expect(spy).not.toHaveBeenCalled();
  });
});

export type { RoomManager };
