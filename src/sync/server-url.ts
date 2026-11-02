// Адрес сервера и ссылки сопряжения для нативной оболочки: там нет «адреса, откуда открыто приложение»,
// поэтому сервер приходится указывать явно. Всё, что пришло извне (ссылка, ввод), проверяется здесь.

export interface PairTarget { baseUrl: string; code: string }

/** Открытый HTTP по локальной сети разрешён только в отладочной сборке: VITE_ALLOW_LAN_HTTP=1. */
export const CLEARTEXT_ALLOWED: boolean = import.meta.env?.VITE_ALLOW_LAN_HTTP === '1';

/** «pc.tailnet.ts.net», «https://192.168.1.5:8443/» → «https://…» без пути и слеша. Бросает Error с понятным текстом. */
export function normalizeServerUrl(input: string, allowHttp: boolean = CLEARTEXT_ALLOWED): string {
  const raw = input.trim();
  if (!raw) throw new Error('Укажи адрес сервера.');
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error('Адрес сервера выглядит неправильно.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Адрес сервера должен начинаться с https://');
  if (u.protocol === 'http:' && !allowHttp) throw new Error('Эта сборка подключается только по https:// (например, через Tailscale).');
  if (u.username || u.password) throw new Error('В адресе сервера не должно быть логина и пароля.');
  return u.origin;
}

const CODE_RE = /^[A-Za-z0-9-]{4,32}$/;

/**
 * Разбирает ссылку сопряжения:
 *  - workout://pair?url=https%3A%2F%2Fpc.ts.net&code=ABCD-1234 (для нативного приложения);
 *  - https://pc.ts.net/#/pair/ABCD-1234 (ссылка из QR для браузера: адрес берём из неё же).
 * Возвращает null, если это не ссылка сопряжения. Бросает Error, если ссылка похожа на неё, но адрес недопустим.
 */
export function parsePairLink(link: string, allowHttp: boolean = CLEARTEXT_ALLOWED): PairTarget | null {
  let u: URL;
  try { u = new URL(link.trim()); } catch { return null; }

  if (u.protocol === 'workout:') {
    // workout://pair?… разбирается как host=pair; workout:pair?… и workout:///pair?… тоже допустимы
    const where = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
    if (where !== 'pair') return null;
    const url = u.searchParams.get('url'), code = u.searchParams.get('code');
    if (!url || !code || !CODE_RE.test(code)) return null;
    return { baseUrl: normalizeServerUrl(url, allowHttp), code };
  }

  if (u.protocol === 'https:' || u.protocol === 'http:') {
    const m = /^#\/pair\/([^/?#]+)/.exec(u.hash);
    if (!m || !CODE_RE.test(decodeURIComponent(m[1]))) return null;
    return { baseUrl: normalizeServerUrl(u.origin, allowHttp), code: decodeURIComponent(m[1]) };
  }
  return null;
}
