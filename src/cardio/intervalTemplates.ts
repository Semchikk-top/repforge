// Шаблоны интервальных тренировок. Лежат в локальном хранилище kv этого устройства (схема базы не меняется),
// на другие устройства не синхронизируются. Всё прочитанное проходит проверку: испорченный шаблон просто пропускается.

import { db } from '../db/db';
import type { IntervalPlan, Sport } from '../domain/types';
import { newId } from '../lib';
import { validatePlan } from './intervals';

export const TEMPLATES_KEY = 'cardio.interval.templates';
export const MAX_TEMPLATES = 20;
export const MAX_TITLE = 40;

export interface IntervalTemplate { id: string; title: string; sport: Sport; plan: IntervalPlan }

export function sanitizeTemplates(raw: unknown): IntervalTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: IntervalTemplate[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const v = t as Partial<IntervalTemplate>;
    if (typeof v.id !== 'string' || typeof v.title !== 'string' || !v.title.trim() || typeof v.sport !== 'string') continue;
    if (validatePlan(v.plan) !== null) continue;
    out.push({ id: v.id, title: v.title.trim().slice(0, MAX_TITLE), sport: v.sport as Sport, plan: v.plan as IntervalPlan });
    if (out.length >= MAX_TEMPLATES) break;
  }
  return out;
}

export async function loadTemplates(): Promise<IntervalTemplate[]> {
  return sanitizeTemplates((await db.kv.get(TEMPLATES_KEY))?.value);
}

/** Добавляет шаблон; одинаковое название у того же вида заменяет прежний. Возвращает текст ошибки или null. */
export async function saveTemplate(title: string, sport: Sport, plan: IntervalPlan): Promise<string | null> {
  const name = title.trim().slice(0, MAX_TITLE);
  if (!name) return 'Назови шаблон';
  const err = validatePlan(plan);
  if (err) return err;
  const cur = await loadTemplates();
  const same = cur.find((t) => t.sport === sport && t.title.toLowerCase() === name.toLowerCase());
  if (!same && cur.length >= MAX_TEMPLATES) return `Не больше ${MAX_TEMPLATES} шаблонов, удали ненужные`;
  const next = same ? cur.map((t) => (t === same ? { ...t, plan } : t)) : [...cur, { id: newId(), title: name, sport, plan }];
  await db.kv.put({ key: TEMPLATES_KEY, value: next });
  return null;
}

export async function deleteTemplate(id: string): Promise<void> {
  const cur = await loadTemplates();
  await db.kv.put({ key: TEMPLATES_KEY, value: cur.filter((t) => t.id !== id) });
}
