// Перенос профиля между устройствами: ключ подписи ходит только в виде слепка,
// зашифрованного паролем; на втором устройстве подпись возвращается тем же паролем.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateIdentityKey, signText, unwrapIdentityKey, verifyText, wrapIdentityKey } from '../../src/social/crypto';
import { db } from '../../src/db/db';
import { buildMySnapshots, ensureProfile, ensureProfileMeta, getProfile, renameProfile, unlockProfile } from '../../src/social/store';
import { canonicalJson } from '../../src/social/crypto';

/** «Устройство Б»: профиль так, как он приходит синхронизацией — без privateKey (JSON-круг). */
async function arriveAsOtherDevice() {
  const me = await getProfile();
  expect(me).toBeTruthy();
  const wire = JSON.parse(JSON.stringify({ ...me!, privateKey: undefined }));
  await db.profile.clear();
  await db.profile.put({ ...wire, updatedAt: (me!.updatedAt ?? 0) + 1, deviceId: 'device-b' });
}

beforeEach(async () => {
  await Promise.all([db.profile.clear(), db.changes.clear()]);
});

describe('слепок ключа под паролем', () => {
  it('Ed25519: шифрование и расшифровка дают тот же ключ подписи', async () => {
    const key = await generateIdentityKey('ed25519', true);
    const wrapped = await wrapIdentityKey(key.privateKey, key.alg, 'пароль-1');
    expect(wrapped).toMatchObject({ v: 1, alg: 'ed25519', iters: 310000 });
    const back = await unwrapIdentityKey(wrapped, 'пароль-1');
    expect(back.extractable).toBe(false);
    const sig1 = await signText({ alg: key.alg, privateKey: key.privateKey }, 'текст');
    const sig2 = await signText({ alg: key.alg, privateKey: back }, 'текст');
    expect(sig1).toBe(sig2); // Ed25519 детерминирован: подписи совпадают байт в байт
    expect(await verifyText(key.publicKey, 'текст', sig2)).toBe(true);
  });

  it('P-256: то же самое', async () => {
    const key = await generateIdentityKey('p256', true);
    const wrapped = await wrapIdentityKey(key.privateKey, key.alg, 'пароль-2');
    const back = await unwrapIdentityKey(wrapped, 'пароль-2');
    const sig = await signText({ alg: key.alg, privateKey: back }, 'текст');
    expect(await verifyText(key.publicKey, 'текст', sig)).toBe(true);
  });

  it('чужой пароль слепок не расшифровывает', async () => {
    const key = await generateIdentityKey('ed25519', true);
    const wrapped = await wrapIdentityKey(key.privateKey, key.alg, 'верный');
    await expect(unwrapIdentityKey(wrapped, 'неверный')).rejects.toThrow('Неверный пароль');
  });
});

describe('профиль через синхронизацию', () => {
  it('создание с паролем: подпись работает локально, слепок уезжает, ключ — нет', async () => {
    const me = await ensureProfile('Аня', 'пароль');
    expect(me.wrapped).toBeTruthy();
    expect(me.privateKey!.extractable).toBe(false); // в хранилище лежит неэкспортируемый ключ
    await db.workouts.bulkAdd([{
      id: 'w1', date: '2026-10-26', title: 'T', status: 'done', createdAt: 1, updatedAt: 1, deviceId: 'd',
      exercises: [{ id: 's1', exerciseId: 'e1', sets: [{ id: 'x', weight: 80, reps: 10, done: true }] }]
    }]);
    await db.exercises.bulkAdd([{ id: 'e1', name: 'Жим', muscle: 'chest', equipment: 'штанга', custom: false, updatedAt: 1, deviceId: 'd' }]);
    const snaps = await buildMySnapshots(new Date('2026-10-28T12:00:00'));
    expect(snaps).toHaveLength(3); // неделя, 4 недели, всё время
    expect(await verifyText(me.publicKey, canonicalJson({ ...snaps[0], sig: undefined }), snaps[0].sig)).toBe(true);
  });

  it('второе устройство: без пароля подписи нет, с паролем — есть', async () => {
    const me = await ensureProfile('Аня', 'пароль');
    await arriveAsOtherDevice();
    const arrived = await getProfile();
    expect(arrived!.privateKey).toBeUndefined();
    expect(arrived!.wrapped).toBeTruthy();
    expect(arrived!.displayName).toBe('Аня');
    expect(await buildMySnapshots(new Date('2026-10-28T12:00:00'))).toEqual([]); // подписать нечем

    expect(await unlockProfile('неверный')).toBe(false);
    expect((await getProfile())!.privateKey).toBeUndefined();

    const logBefore = await db.changes.where('table').equals('profile').count();

    expect(await unlockProfile('пароль')).toBe(true);
    const unlocked = await getProfile();
    expect(unlocked!.privateKey!.extractable).toBe(false);
    const sig = await signText({ alg: unlocked!.alg, privateKey: unlocked!.privateKey! }, 'текст');
    expect(await verifyText(me.publicKey, 'текст', sig)).toBe(true); // та же личность
    expect(await buildMySnapshots(new Date('2026-10-28T12:00:00')).then((s) => s.length)).toBe(3);
    // разблокировка — локальное обогащение: в журнал синхронизации ничего не добавилось
    expect(await db.changes.where('table').equals('profile').count()).toBe(logBefore);
  });

  it('имя профиля синхронизируется: правка пишет мета-поля и запись журнала', async () => {
    await ensureProfile('Аня', 'пароль');
    await db.changes.clear(); // создание уже записано в журнал; интересна именно правка имени
    const before = (await getProfile())!.updatedAt;
    await renameProfile('Аня П.');
    const after = await getProfile();
    expect(after!.displayName).toBe('Аня П.');
    expect(after!.updatedAt).toBeGreaterThanOrEqual(before);
    const log = await db.changes.where('table').equals('profile').toArray();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ table: 'profile', entityId: 'me', op: 'put' });
  });

  it('старый профиль (без мета-полей) дописывается при старте и уезжает без ключа', async () => {
    const key = await generateIdentityKey('ed25519', false);
    await db.profile.put({
      id: 'me', profileId: 'p_old', displayName: 'Старый', alg: key.alg, publicKey: key.publicKey,
      privateKey: key.privateKey, createdAt: 1, schema: 1
    } as never);
    await ensureProfileMeta();
    const me = await getProfile();
    expect(me!.updatedAt).toBeGreaterThan(0);
    expect(me!.deviceId).toBeTruthy();
    expect(me!.wrapped).toBeUndefined(); // слепка нет: ключ остаётся только на исходном устройстве
    const log = await db.changes.where('table').equals('profile').toArray();
    expect(log).toHaveLength(1);
  });
});
