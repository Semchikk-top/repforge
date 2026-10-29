// Каталог стартовых упражнений для сервиса мирового рейтинга: board/seed_exercises.json.
// Сервис показывает названия только из этого списка, а не те, что прислал клиент.
// Запуск: npx vite-node scripts/gen-board-seed.ts   (тест проверяет, что файл не отстал от seed.ts)
import { writeFileSync } from 'node:fs';
import { SEED_EXERCISES } from '../src/domain/seed';

const out = Object.fromEntries(SEED_EXERCISES.filter((e) => e.muscle !== 'cardio').map((e) => [e.id, { name: e.name, muscle: e.muscle }]));
writeFileSync(new URL('../board/seed_exercises.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log('board/seed_exercises.json:', Object.keys(out).length, 'упражнений');
