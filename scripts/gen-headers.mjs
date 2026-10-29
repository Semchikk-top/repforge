// Заголовки безопасности для статического хостинга (Cloudflare Pages, Netlify) после `vite build`:
//   VITE_ROOM_RELAY_URL=wss://relay.example VITE_BOARD_URL=https://board.example npm run build:public
// Кроме адреса приложения в connect-src разрешаются только релей и сервис мирового рейтинга; всё остальное закрыто так же, как на своём сервере.
import { writeFileSync, mkdirSync } from 'node:fs';

const raw = (process.env.VITE_ROOM_RELAY_URL ?? '').trim();
let relay = '';
if (raw) {
  const u = new URL(raw);
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('VITE_ROOM_RELAY_URL должен начинаться с ws:// или wss://');
  relay = ` ${u.protocol}//${u.host}`;
}
const boardRaw = (process.env.VITE_BOARD_URL ?? '').trim();
let board = '';
if (boardRaw) {
  const u = new URL(boardRaw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('VITE_BOARD_URL должен начинаться с http:// или https://');
  board = ` ${u.protocol}//${u.host}`;
}
const csp = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self' data:",
  `connect-src 'self'${relay}${board}`, "manifest-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
].join('; ');

mkdirSync('dist', { recursive: true });
writeFileSync('dist/_headers', `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(self)
`);
console.log('dist/_headers записан; релей:', relay.trim() || 'не задан', '; рейтинг:', board.trim() || 'не задан');
