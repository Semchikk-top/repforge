// Справочное содержимое: проверка, сборка, смена статуса.
//   npm run content:check                 проверить всё в content/
//   npm run content:build                 собрать в src/content/bundle.generated.json только published
//   npm run content:preview               то же, но с черновиками (только посмотреть на своём устройстве)
//   npm run content:status -- seed-001 reviewed|published|draft
// Статус меняет только человек: модель и скрипты сами ничего не публикуют.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SEED_EXERCISES } from '../src/domain/seed';
import { movementOf } from '../src/domain/movements';
import { MUSCLE_LABELS } from '../src/domain/types';
import { buildBundle } from '../src/content/build';
import { STATUSES, type Card, type ContentStatus, type Course, type Muscle, type Principle, type Question, type Source } from '../src/content/types';
import { validateCard, validateCourse, validateMuscles, validatePrinciple, validateSources } from '../src/content/validate';

// REPFORGE_CONTENT_DIR нужен тестам конвейера знаний: они проверяют, что принятая карточка проходит те же проверки, что и приложение.
const root = process.env.REPFORGE_CONTENT_DIR ? pathToFileURL(resolve(process.env.REPFORGE_CONTENT_DIR) + '/') : new URL('../content/', import.meta.url);
const bundlePath = new URL('../src/content/bundle.generated.json', import.meta.url);
const readJson = (u: URL): unknown => JSON.parse(readFileSync(u, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const namesPath = new URL('exercise_names.json', root);
/** id → название всех стартовых упражнений. Нужен ассистенту на сервере: у него нет доступа к seed.ts (файл рейтинга без кардио). */
const namesText = () => JSON.stringify(Object.fromEntries(SEED_EXERCISES.map((e) => [e.id, e.name])), null, 1) + '\n';

function load() {
  const muscles = readJson(new URL('muscles.json', root)) as Muscle[];
  const sources = readJson(new URL('sources.json', root)) as Source[];
  const dir = new URL('exercises/', root);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const cards = files.map((f) => ({ file: f, card: readJson(new URL(f, dir)) as Card }));
  const pdir = new URL('principles/', root);
  const pfiles = existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith('.json')).sort() : [];
  const principles = pfiles.map((f) => ({ file: f, card: readJson(new URL(f, pdir)) as Principle }));
  const cdir = new URL('courses/', root);
  const courseIds = existsSync(cdir) ? readdirSync(cdir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  const courses = courseIds.map((dirName) => {
    const qf = new URL(`${dirName}/questions.json`, cdir);
    return { dirName, course: readJson(new URL(`${dirName}/course.json`, cdir)) as Course, questions: (existsSync(qf) ? readJson(qf) : null) as Question[] | null };
  });
  return { muscles, sources, cards, principles, courses };
}

function problems(data: ReturnType<typeof load>): string[] {
  const errors = [
    ...validateMuscles(data.muscles, Object.keys(MUSCLE_LABELS)),
    ...validateSources(data.sources, today)
  ];
  const ctx = {
    muscleIds: new Set(data.muscles.map((m) => m.id)),
    sourceIds: new Set(data.sources.map((s) => s.id)),
    exerciseIds: new Set(SEED_EXERCISES.map((e) => e.id))
  };
  const ids = new Set<string>();
  for (const { file, card } of data.cards) {
    errors.push(...validateCard(card, ctx));
    if (file !== `${card.id}.json`) errors.push(`${file}: имя файла должно совпадать с id карточки (${card.id}.json)`);
    if (ids.has(card.id)) errors.push(`${card.id}: две карточки на одно упражнение`);
    ids.add(card.id);
    const ex = SEED_EXERCISES.find((e) => e.id === card.id);
    // силовое упражнение без движения в domain/movements.ts не получит подсказку о замене: ловим рассинхрон
    if (ex && ex.muscle !== 'cardio' && !movementOf({ id: ex.id, name: ex.name, muscle: ex.muscle })) errors.push(`${card.id}: для «${ex.name}» нет движения в domain/movements.ts`);
  }
  const sourceIds = new Set(data.sources.map((s) => s.id));
  const pids = new Set<string>();
  for (const { file, card } of data.principles) {
    errors.push(...validatePrinciple(card, { sourceIds }));
    if (file !== `${card.id}.json`) errors.push(`principles/${file}: имя файла должно совпадать с id (${card.id}.json)`);
    if (pids.has(card.id)) errors.push(`${card.id}: два принципа с одним id`);
    pids.add(card.id);
  }
  const cctx = { sourceIds, exerciseIds: new Set(SEED_EXERCISES.map((e) => e.id)), principleIds: new Set(data.principles.map((p) => p.card.id)) };
  const cids = new Set<string>();
  for (const { dirName, course, questions } of data.courses) {
    errors.push(...validateCourse(course, questions, cctx));
    if (dirName !== course.id) errors.push(`courses/${dirName}: имя каталога должно совпадать с id курса (${course.id})`);
    if (cids.has(course.id)) errors.push(`${course.id}: два курса с одним id`);
    cids.add(course.id);
  }
  if (!existsSync(namesPath) || readFileSync(namesPath, 'utf8') !== namesText()) errors.push('content/exercise_names.json устарел: npm run content:build');
  return errors;
}

function fail(errors: string[]): never {
  console.error(`Ошибок: ${errors.length}`);
  for (const e of errors) console.error(' - ' + e);
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
const data = load();
const errors = problems(data);

if (cmd === 'check') {
  if (errors.length) fail(errors);
  if (args.includes('--release')) {
    const b = readJson(bundlePath) as { preview?: boolean };
    if (b.preview) fail(['bundle.generated.json собран с черновиками (preview). Перед релизом: npm run content:build']);
  }
  const count = (s: ContentStatus) => data.cards.filter((c) => c.card.status === s).length;
  console.log(`content: ок. Карточек: ${data.cards.length} (published ${count('published')}, reviewed ${count('reviewed')}, draft ${count('draft')}), принципов ${data.principles.length}, курсов ${data.courses.length}, мышц ${data.muscles.length}, источников ${data.sources.length}`);
} else if (cmd === 'build') {
  writeFileSync(namesPath, namesText());
  const rest = errors.filter((e) => !e.includes('exercise_names.json'));
  if (rest.length) fail(rest);
  const preview = args.includes('--preview') || process.env.CONTENT_PREVIEW === '1';
  const bundle = buildBundle(data.cards.map((c) => c.card), data.muscles, data.sources, { preview, principles: data.principles.map((p) => p.card), courses: data.courses.map((c) => ({ course: c.course, questions: c.questions ?? [] })) });
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 1) + '\n');
  console.log(`content:build: в сборку ${Object.keys(bundle.cards).length} карточек и ${Object.keys(bundle.principles).length} принципов и ${Object.keys(bundle.courses ?? {}).length} курсов${preview ? ' (ПРЕДПРОСМОТР: включены черновики, в релиз не отправлять)' : ''}`);
} else if (cmd === 'status') {
  const [id, status] = args;
  if (!id || !(STATUSES as readonly string[]).includes(status)) fail(['использование: npm run content:status -- <id> <draft|reviewed|published>']);
  const principleHit = data.principles.find((c) => c.card.id === id);
  const courseHit = data.courses.find((c) => c.course.id === id);
  if (courseHit) {
    const reviewedAt = status === 'draft' ? null : courseHit.course.reviewedAt ?? today;
    const next = { ...courseHit.course, status: status as ContentStatus, reviewedAt };
    const bad = validateCourse(next, courseHit.questions, { sourceIds: new Set(data.sources.map((s) => s.id)), exerciseIds: new Set(SEED_EXERCISES.map((e) => e.id)), principleIds: new Set(data.principles.map((p) => p.card.id)) });
    if (bad.length) fail(bad);
    writeFileSync(new URL(`courses/${courseHit.dirName}/course.json`, root), JSON.stringify(next, null, 2) + '\n');
    console.log(`${id}: ${courseHit.course.status} → ${status} (курс; версию содержимого повышай при правке текста)`);
    process.exit(0);
  }
  const hit = data.cards.find((c) => c.card.id === id) ?? principleHit;
  if (!hit) fail([`карточки или принципа «${id}» нет`]);
  const dir = principleHit ? 'principles/' : 'exercises/';
  const reviewedAt = status === 'draft' ? null : hit.card.reviewedAt ?? today;
  const next = { ...hit.card, status: status as ContentStatus, reviewedAt } as Card & Principle;
  const sourceIds = new Set(data.sources.map((s) => s.id));
  const ctx = { muscleIds: new Set(data.muscles.map((m) => m.id)), sourceIds, exerciseIds: new Set(SEED_EXERCISES.map((e) => e.id)) };
  const bad = principleHit ? validatePrinciple(next, { sourceIds }) : validateCard(next, ctx);
  if (bad.length) fail(bad);
  writeFileSync(new URL(`${dir}${hit.file}`, root), JSON.stringify(next, null, 2) + '\n');
  console.log(`${id}: ${hit.card.status} → ${status}`);
} else {
  console.error('команды: check [--release] | build [--preview] | status <id> <статус>');
  process.exit(2);
}
