import { db } from '../db/db';

// Отдельный модуль: карточка на календаре (основной чанк) не должна тянуть за собой весь экран онбординга.
export const ONBOARDING_DISMISSED = 'onboarding.dismissed';
export const dismissOnboarding = () => db.kv.put({ key: ONBOARDING_DISMISSED, value: true });
