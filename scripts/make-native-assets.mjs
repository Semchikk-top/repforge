// Рисует исходники иконки и экрана запуска из той же гантели, что и иконка PWA (public/icon.svg),
// затем `capacitor-assets` раскладывает их по папкам Android. Запуск: npm run native:assets
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const BG = '#12161c';
const bar = (scale, cx, cy) => `
  <g transform="translate(${cx} ${cy}) scale(${scale}) translate(-256 -256)">
    <rect x="96" y="236" width="320" height="40" rx="8" fill="#8a93a1"/>
    <rect x="120" y="150" width="44" height="212" rx="10" fill="#d9a441"/>
    <rect x="348" y="150" width="44" height="212" rx="10" fill="#d9a441"/>
    <rect x="76" y="190" width="36" height="132" rx="8" fill="#e8e6e1"/>
    <rect x="400" y="190" width="36" height="132" rx="8" fill="#e8e6e1"/>
  </g>`;
const svg = (size, body, bg) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ''}${body}</svg>`);

mkdirSync(new URL('../assets/', import.meta.url), { recursive: true });
const out = (name) => new URL(`../assets/${name}`, import.meta.url).pathname;
const png = async (name, buf) => { await sharp(buf).png().toFile(out(name)); console.log('assets/' + name); };

// адаптивная иконка: содержимое должно умещаться в центральные ~60 %, остальное система обрежет маской
await png('icon-foreground.png', svg(1024, bar(1.45, 512, 512)));
await png('icon-background.png', svg(1024, '', BG));
await png('icon-only.png', svg(1024, bar(1.6, 512, 512), BG));
await png('splash.png', svg(2732, bar(2.2, 1366, 1366), BG));
await png('splash-dark.png', svg(2732, bar(2.2, 1366, 1366), BG));
