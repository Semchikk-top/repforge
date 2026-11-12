// Сборка справочника: в приложение попадает только то, что человек опубликовал.
import type { Bundle, Card, CourseBundle, Muscle, Principle, Source } from './types';

export interface BuildOptions {
  /** Включить черновики и проверенное, но не опубликованное. Только для просмотра на своём устройстве. */
  preview?: boolean;
  /** Заметки-принципы (1.4.0). Попадают в сборку по тем же правилам статусов. */
  principles?: Principle[];
  /** Курсы с банком вопросов (1.5.0): по тем же правилам статусов. */
  courses?: CourseBundle[];
}

export function buildBundle(cards: Card[], muscles: Muscle[], sources: Source[], opts: BuildOptions = {}): Bundle {
  const preview = !!opts.preview;
  const picked = cards.filter((c) => preview || c.status === 'published').sort((a, b) => a.id.localeCompare(b.id));
  const muscleName = new Map(muscles.map((m) => [m.id, m.name]));
  const muscleGroup = new Map(muscles.map((m) => [m.id, m.group]));
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const out: Bundle = { schema: 1, preview, muscles: {}, muscleGroups: {}, sources: {}, cards: {}, principles: {}, courses: {} };
  for (const c of picked) {
    out.cards[c.id] = c;
    for (const m of [...c.primaryMuscles, ...c.secondaryMuscles]) {
      out.muscles[m] = muscleName.get(m) ?? m;
      const g = muscleGroup.get(m);
      if (g) out.muscleGroups![m] = g;
    }
    for (const s of c.sources) { const src = sourceById.get(s); if (src) out.sources[s] = src; }
  }
  const notes = (opts.principles ?? []).filter((n) => preview || n.status === 'published').sort((a, b) => a.id.localeCompare(b.id));
  for (const n of notes) {
    out.principles[n.id] = n;
    for (const s of n.sources) { const src = sourceById.get(s); if (src) out.sources[s] = src; }
  }
  const courses = (opts.courses ?? []).filter((c) => preview || c.course.status === 'published').sort((a, b) => a.course.id.localeCompare(b.course.id));
  for (const c of courses) {
    out.courses![c.course.id] = c;
    for (const s of c.course.sources) { const src = sourceById.get(s); if (src) out.sources[s] = src; }
    for (const q of c.questions) if (q.source) { const src = sourceById.get(q.source); if (src) out.sources[q.source] = src; }
  }
  return out;
}
