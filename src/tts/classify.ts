// Какие фразы озвучивает Fish, а какие системный голос (план «Fish Speech», раздел 4).
//
//  static  — конечный набор текстов без чисел из замеров: готовится заранее при подготовке голоса;
//  route   — манёвры и стартовая фраза маршрута: известны в момент построения маршрута, готовятся тогда;
//  dynamic — всё, что зависит от фактического времени, темпа, пульса, расстояния: километровые отрезки, текущий темп,
//            половина дистанции, итоги, сход с маршрута с расстоянием, интервалы. Склейка заготовленных «атомов» даёт
//            эффект перечисления, а предгенерировать все варианты нельзя, поэтому они всегда идут системным голосом.
//
// Во время записи сетевых вызовов нет: динамические фразы в пак не попадают, а у остальных проверяется только локальный файл.

import type { PlannedRoute } from '../domain/types';
import { ANNOUNCE_THRESHOLDS } from '../cardio/nav';
import {
  arrivedText, backOnRouteText, maneuverText, paceOkText, rerouteFailText, rerouteOkText, reroutingText, startText, zoneText
} from '../cardio/voice';

export type PhraseKind = 'static' | 'route' | 'dynamic';

/** Источники фраз, которые остаются у системного голоса. Список нужен документации и тестам. */
export const DYNAMIC_SOURCES = [
  'voiceText (километровые отрезки)', 'halfText (половина дистанции, остаток)', 'finishText (итоги)', 'offRouteText (сход с маршрута, расстояние)',
  'coachStep: темп медленнее/быстрее цели (текущий темп)', 'eventPhrase (интервальные тренировки)'
] as const;

/** Статические фразы кардио. */
export function staticTexts(): string[] {
  const t = [
    startText(null), reroutingText(), rerouteOkText(), rerouteFailText(true), rerouteFailText(false), backOnRouteText(), arrivedText(), paceOkText(),
    ...[0, 1, 2, 3, 4, 5].map(zoneText)
  ];
  return dedupe(t);
}

/**
 * Фразы построенного маршрута: стартовая и манёвры на каждом пороге оповещения.
 * Промежуточные точки озвучиваются как обычные манёвры, пункт назначения — статической фразой «Вы пришли…».
 */
export function routeTexts(plan: PlannedRoute): string[] {
  const ths = ANNOUNCE_THRESHOLDS[plan.profile];
  const out = [startText(plan)];
  for (const m of plan.maneuvers) {
    const isDestination = m.type >= 4 && m.type <= 6 && !m.via;
    if (isDestination) continue;
    for (const th of ths) out.push(maneuverText(m, th, ths));
  }
  return dedupe(out);
}

const dedupe = (a: string[]): string[] => [...new Set(a.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean))];
