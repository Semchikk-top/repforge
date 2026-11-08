export const uid = (): string =>
  (crypto as Crypto).randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

export const pad = (n: number) => String(n).padStart(2, '0');

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayStr = () => toDateStr(new Date());

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatDateLong(s: string): string {
  return parseDate(s).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} мин`;
  return `${Math.floor(min / 60)} ч ${min % 60} мин`;
}

/** Склонение по числу: pluralRu(2, 'тренировка', 'тренировки', 'тренировок'). */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  return b >= 2 && b <= 4 ? few : many;
}

export function formatNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

// Понедельник недели, в которую попадает дата
export function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - wd);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export const newId = uid;
