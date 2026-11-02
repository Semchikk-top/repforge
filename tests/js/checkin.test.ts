import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkInId, checkInSeries, compareDay, filledSlots, findCheckIn, normalizeCheckIn, readiness, seriesAverage, type CheckInDraft
} from '../../src/domain/checkin';
import { filterBackup } from '../../src/domain/exportData';
import type { CheckIn, Rating } from '../../src/domain/types';
import { db } from '../../src/db/db';
import { deleteCheckIn, exportAll, importAll, saveCheckIn } from '../../src/db/repo';
import { isDataEmpty } from '../../src/db/autoBackup';
import { applyRemote } from '../../src/sync/sync';
import { conflictLabel } from '../../src/sync/conflicts';
import { checkInReminderId, currentSlot, planCheckInReminders, slotFromTag, type CheckInReminderSettings } from '../../src/state/checkinPlan';
import { staleReminderIds } from '../../src/state/notifyPlan';

const R = (n: number) => n as Rating;
const draft = (date: string, slot: 'morning' | 'evening', extra: Partial<CheckInDraft> = {}): CheckInDraft =>
  ({ date, slot, energy: R(4), mood: R(4), soreness: R(2), stress: R(2), ...extra });
const row = (date: string, slot: 'morning' | 'evening', extra: Partial<CheckIn> = {}): CheckIn =>
  ({ id: checkInId(date, slot), createdAt: 1, updatedAt: 1, deviceId: 'd', date, slot, energy: R(3), mood: R(3), soreness: R(3), stress: R(3), ...extra });

describe('готовность', () => {
  it('середина шкалы даёт 50, а перевёрнутые болезненность и стресс считаются как «лучше, когда меньше»', () => {
    const r = readiness({ energy: R(3), mood: R(3), soreness: R(3), stress: R(3) });
    expect(r.score).toBe(50);
    expect(r.level).toBe('normal');
    const best = readiness({ energy: R(5), mood: R(5), soreness: R(1), stress: R(1) });
    expect(best.score).toBe(100);
    expect(best.level).toBe('high');
    const worst = readiness({ energy: R(1), mood: R(1), soreness: R(5), stress: R(5) });
    expect(worst.score).toBe(0);
    expect(worst.level).toBe('low');
  });

  it('сон учитывается, только если заполнен: 4 часа и меньше — 0, 8 и больше — 100', () => {
    const core = { energy: R(3), mood: R(3), soreness: R(3), stress: R(3) };
    expect(readiness(core).parts.map((p) => p.key)).toEqual(['energy', 'mood', 'soreness', 'stress']);
    const withSleep = readiness({ ...core, sleepHours: 8, sleepQuality: R(5) });
    expect(withSleep.parts.map((p) => p.key)).toContain('sleepHours');
    expect(withSleep.parts.find((p) => p.key === 'sleepHours')!.value).toBe(100);
    expect(readiness({ ...core, sleepHours: 4 }).parts.find((p) => p.key === 'sleepHours')!.value).toBe(0);
    expect(readiness({ ...core, sleepHours: 6 }).parts.find((p) => p.key === 'sleepHours')!.value).toBe(50);
    expect(readiness({ ...core, sleepHours: 12 }).parts.find((p) => p.key === 'sleepHours')!.value).toBe(100);
  });

  it('итог — простое среднее составляющих, каждая видна отдельно', () => {
    const r = readiness({ energy: R(5), mood: R(3), soreness: R(5), stress: R(1) });
    expect(r.parts.map((p) => p.value)).toEqual([100, 50, 0, 100]);
    expect(r.score).toBe(63);
  });
});

describe('нормализация черновика', () => {
  it('поля чужого слота отбрасываются', () => {
    const m = normalizeCheckIn(draft('2026-10-31', 'morning', { sleepHours: 7.3, sleepQuality: R(4), sleepiness: R(5) }))!;
    expect(m.sleepHours).toBe(7.5);
    expect(m.sleepQuality).toBe(4);
    expect('sleepiness' in m).toBe(false);
    const e = normalizeCheckIn(draft('2026-10-31', 'evening', { sleepHours: 7, sleepiness: R(2) }))!;
    expect(e.sleepiness).toBe(2);
    expect('sleepHours' in e).toBe(false);
  });

  it('заметка обрезается по краям и пустая убирается, часы сна ограничены 0–24', () => {
    expect(normalizeCheckIn(draft('2026-10-31', 'evening', { note: '  ' }))!.note).toBeUndefined();
    expect(normalizeCheckIn(draft('2026-10-31', 'evening', { note: ' тяжёлый день ' }))!.note).toBe('тяжёлый день');
    expect(normalizeCheckIn(draft('2026-10-31', 'morning', { sleepHours: 99 }))!.sleepHours).toBe(24);
    expect(normalizeCheckIn(draft('2026-10-31', 'morning', { sleepHours: -3 }))!.sleepHours).toBe(0);
  });

  it('неверная дата, слот или оценка — отказ', () => {
    expect(normalizeCheckIn(draft('31.10.2026', 'morning'))).toBeNull();
    expect(normalizeCheckIn({ ...draft('2026-10-31', 'morning'), slot: 'noon' as never })).toBeNull();
    expect(normalizeCheckIn({ ...draft('2026-10-31', 'morning'), energy: 6 as never })).toBeNull();
    expect(normalizeCheckIn({ ...draft('2026-10-31', 'morning'), mood: undefined as never })).toBeNull();
  });
});

describe('утро и вечер', () => {
  it('сравнивается общее ядро с учётом направления шкалы', () => {
    const m = row('2026-10-31', 'morning', { energy: R(4), mood: R(3), soreness: R(2), stress: R(2) });
    const e = row('2026-10-31', 'evening', { energy: R(2), mood: R(3), soreness: R(1), stress: R(4) });
    const d = compareDay(m, e)!;
    const by = Object.fromEntries(d.map((x) => [x.metric, x]));
    expect(by.energy).toMatchObject({ delta: -2, trend: 'worse' });
    expect(by.mood).toMatchObject({ delta: 0, trend: 'same' });
    expect(by.soreness).toMatchObject({ delta: -1, trend: 'better' }); // болезненность упала: лучше
    expect(by.stress).toMatchObject({ delta: 2, trend: 'worse' });     // стресс вырос: хуже
  });

  it('без одного из слотов сравнивать нечего', () => {
    expect(compareDay(row('2026-10-31', 'morning'), null)).toBeNull();
    expect(compareDay(undefined, row('2026-10-31', 'evening'))).toBeNull();
  });
});

describe('выборки и ряды', () => {
  const list = [
    row('2026-10-29', 'morning', { energy: R(2) }),
    row('2026-10-30', 'morning', { energy: R(4) }),
    row('2026-10-30', 'evening', { energy: R(2) }),
    row('2026-10-31', 'morning', { energy: R(5), sleepHours: 7 }),
    row('2026-10-20', 'morning', { energy: R(1) }),
    row('2026-10-31', 'evening', { energy: R(1), deletedAt: 5 })
  ];
  const now = new Date(2026, 9, 31, 12, 0);

  it('ряд по возрастанию даты, пропущенные дни не заполняются, слоты за дату усредняются', () => {
    const s = checkInSeries(list, 'energy', 7, now);
    expect(s).toEqual([
      { date: '2026-10-29', value: 2 },
      { date: '2026-10-30', value: 3 },
      { date: '2026-10-31', value: 5 } // удалённый вечерний слот не учитывается
    ]);
    expect(seriesAverage(s)).toBeCloseTo(10 / 3, 10);
  });

  it('ряд можно взять по одному слоту, а поле, которого нет, даёт пустой ряд', () => {
    expect(checkInSeries(list, 'energy', 7, now, 'evening')).toEqual([{ date: '2026-10-30', value: 2 }]);
    expect(checkInSeries(list, 'sleepHours', 7, now)).toEqual([{ date: '2026-10-31', value: 7 }]);
    expect(checkInSeries(list, 'sleepQuality', 7, now)).toEqual([]);
    expect(seriesAverage([])).toBeNull();
  });

  it('период ограничивает ряд', () => {
    expect(checkInSeries(list, 'energy', 2, now).map((p) => p.date)).toEqual(['2026-10-30', '2026-10-31']);
  });

  it('заполненные слоты и поиск игнорируют удалённые записи', () => {
    expect([...filledSlots(list, '2026-10-31')]).toEqual(['morning']);
    expect(findCheckIn(list, '2026-10-31', 'evening')).toBeNull();
    expect(findCheckIn(list, '2026-10-30', 'evening')?.energy).toBe(2);
  });
});

describe('напоминания о чек-инах', () => {
  const on: CheckInReminderSettings = { checkinMorningEnabled: true, checkinMorningTime: '08:00', checkinEveningEnabled: true, checkinEveningTime: '21:30' };
  const none = () => false;

  it('по одному на включённый слот и день, по возрастанию, только в будущем', () => {
    const now = new Date(2026, 9, 31, 9, 0).getTime();
    const r = planCheckInReminders({ settings: on, isFilled: none, now, horizonDays: 2 });
    expect(r.map((x) => x.id)).toEqual([
      checkInReminderId('2026-10-31', 'evening'), // утро сегодня уже прошло
      checkInReminderId('2026-11-01', 'morning'),
      checkInReminderId('2026-11-01', 'evening'),
      checkInReminderId('2026-11-02', 'morning')
    ]);
    expect(r[0]).toMatchObject({ at: new Date(2026, 9, 31, 21, 30).getTime(), slot: 'evening', tag: 'checkin-evening' });
    expect(r.every((x) => x.at > now)).toBe(true);
  });

  it('заполненный слот напоминания не получает', () => {
    const now = new Date(2026, 9, 31, 7, 0).getTime();
    const filled = (d: string, s: string) => d === '2026-10-31' && s === 'morning';
    const r = planCheckInReminders({ settings: on, isFilled: filled, now, horizonDays: 1 }).filter((x) => x.date === '2026-10-31');
    expect(r.map((x) => x.slot)).toEqual(['evening']);
  });

  it('выключенные слоты и неверное время не планируются', () => {
    const now = new Date(2026, 9, 31, 7, 0).getTime();
    expect(planCheckInReminders({ settings: { ...on, checkinMorningEnabled: false, checkinEveningEnabled: false }, isFilled: none, now })).toEqual([]);
    expect(planCheckInReminders({ settings: { ...on, checkinMorningTime: '25:00', checkinEveningTime: 'вечером' }, isFilled: none, now })).toEqual([]);
    const onlyEvening = planCheckInReminders({ settings: { ...on, checkinMorningEnabled: false }, isFilled: none, now, horizonDays: 1 });
    expect(onlyEvening.every((x) => x.slot === 'evening')).toBe(true);
  });

  it('после заполнения слота прежнее напоминание попадает в список на отмену', () => {
    const now = new Date(2026, 9, 31, 7, 0).getTime();
    const before = planCheckInReminders({ settings: on, isFilled: none, now, horizonDays: 1 });
    const after = planCheckInReminders({ settings: on, isFilled: (d, s) => d === '2026-10-31' && s === 'morning', now, horizonDays: 1 });
    expect(staleReminderIds(before.map((x) => x.id), after)).toEqual([checkInReminderId('2026-10-31', 'morning')]);
  });

  it('слот по времени суток и по тегу уведомления', () => {
    expect(currentSlot(new Date(2026, 9, 31, 9, 0))).toBe('morning');
    expect(currentSlot(new Date(2026, 9, 31, 15, 0))).toBe('evening');
    expect(slotFromTag('checkin-evening')).toBe('evening');
    expect(slotFromTag('workout-reminder')).toBeNull();
  });
});

describe('хранение, синхронизация, экспорт', () => {
  beforeEach(async () => {
    await db.checkins.clear();
    await db.changes.clear();
    await db.conflicts.clear();
  });

  it('один слот на дату: повторное сохранение правит ту же запись', async () => {
    const a = (await saveCheckIn(draft('2026-10-31', 'morning', { energy: R(2) })))!;
    const b = (await saveCheckIn(draft('2026-10-31', 'morning', { energy: R(5) })))!;
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(a.createdAt);
    expect(await db.checkins.count()).toBe(1);
    expect((await db.checkins.get(a.id))!.energy).toBe(5);
    await saveCheckIn(draft('2026-10-31', 'evening'));
    expect(await db.checkins.count()).toBe(2);
  });

  it('уже существующая запись под другим id правится, а не дублируется', async () => {
    await db.checkins.put(row('2026-10-31', 'morning', { id: 'imported-1', energy: R(1) }));
    const saved = (await saveCheckIn(draft('2026-10-31', 'morning', { energy: R(4) })))!;
    expect(saved.id).toBe('imported-1');
    expect(await db.checkins.count()).toBe(1);
  });

  it('неверный черновик не сохраняется', async () => {
    expect(await saveCheckIn({ ...draft('2026-10-31', 'morning'), energy: 9 as never })).toBeNull();
    expect(await db.checkins.count()).toBe(0);
    expect(await db.changes.count()).toBe(0);
  });

  it('сохранение попадает в очередь синхронизации одной строкой на запись', async () => {
    await saveCheckIn(draft('2026-10-31', 'morning'));
    await saveCheckIn(draft('2026-10-31', 'morning', { energy: R(1) }));
    const ch = await db.changes.toArray();
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ table: 'checkins', entityId: checkInId('2026-10-31', 'morning'), op: 'put', synced: 0 });
  });

  it('удаление мягкое, слот можно заполнить заново', async () => {
    await saveCheckIn(draft('2026-10-31', 'morning'));
    await deleteCheckIn('2026-10-31', 'morning');
    const gone = (await db.checkins.get(checkInId('2026-10-31', 'morning')))!;
    expect(gone.deletedAt).toBeTruthy();
    expect(filledSlots([gone], '2026-10-31').size).toBe(0);
    const again = (await saveCheckIn(draft('2026-10-31', 'morning')))!;
    expect(again.deletedAt).toBeNull();
    expect(await db.checkins.count()).toBe(1);
  });

  it('данные с сервера применяются, а чужая правка поверх несинхронизированной даёт карточку конфликта', async () => {
    await applyRemote([{ table: 'checkins', id: 'ci:2026-10-30:morning', updatedAt: 10, deviceId: 'other', deleted: false, data: { date: '2026-10-30', slot: 'morning', energy: 3, mood: 3, soreness: 3, stress: 3, createdAt: 1 } }] as never, [], 1);
    expect((await db.checkins.get('ci:2026-10-30:morning'))!.energy).toBe(3);

    await saveCheckIn(draft('2026-10-31', 'morning', { energy: R(2) })); // несинхронизированная правка
    await applyRemote([{ table: 'checkins', id: checkInId('2026-10-31', 'morning'), updatedAt: Date.now() + 10_000, deviceId: 'zzz', deleted: false, data: { date: '2026-10-31', slot: 'morning', energy: 5, mood: 5, soreness: 1, stress: 1, createdAt: 1 } }] as never, [], 2);
    expect((await db.checkins.get(checkInId('2026-10-31', 'morning')))!.energy).toBe(5);
    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].label).toBe('Чек-ин 2026-10-31 · утро');
    expect(conflictLabel('checkins', { date: '2026-10-31', slot: 'evening' })).toBe('Чек-ин 2026-10-31 · вечер');
  });

  it('записи неизвестной таблицы с сервера по-прежнему игнорируются', async () => {
    await applyRemote([{ table: 'nope', id: 'x', updatedAt: 1, deviceId: 'o', deleted: false, data: { a: 1 } }] as never, [], 3);
    expect(await db.checkins.count()).toBe(0);
  });

  it('экспорт содержит чек-ины, импорт возвращает их и не затирает более свежие', async () => {
    await saveCheckIn(draft('2026-10-30', 'evening', { sleepiness: R(3), note: 'устал' }));
    const json = await exportAll();
    expect(JSON.parse(json).checkins).toHaveLength(1);

    await db.checkins.clear();
    await importAll(json);
    expect((await db.checkins.get(checkInId('2026-10-30', 'evening')))!.note).toBe('устал');

    const fresh = (await db.checkins.get(checkInId('2026-10-30', 'evening')))!;
    await db.checkins.put({ ...fresh, note: 'новее', updatedAt: fresh.updatedAt + 1000 });
    await importAll(json);
    expect((await db.checkins.get(checkInId('2026-10-30', 'evening')))!.note).toBe('новее');
  });

  it('битые записи в файле импорта пропускаются', async () => {
    const json = JSON.stringify({ version: 1, checkins: [{ id: 5 }, null, { id: 'x', slot: 'noon' }, row('2026-10-30', 'morning')] });
    await importAll(json);
    expect(await db.checkins.count()).toBe(1);
  });

  it('копия за период оставляет чек-ины только из периода, а данные, состоящие только из чек-инов, не считаются пустыми', async () => {
    const f = filterBackup({ checkins: [row('2026-10-01', 'morning'), row('2026-10-30', 'morning')] }, { from: '2026-10-20', to: '2026-10-31' });
    expect(f.checkins!.map((c) => c.date)).toEqual(['2026-10-30']);
    expect(await isDataEmpty()).toBe(true);
    await saveCheckIn(draft('2026-10-31', 'morning'));
    expect(await isDataEmpty()).toBe(false);
  });
});
