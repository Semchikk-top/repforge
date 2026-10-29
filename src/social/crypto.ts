// Ключи профиля и подписи. Предпочтительно Ed25519, иначе ECDSA P-256 (по возможностям браузера).
// Приватный ключ создаётся неэкспортируемым: приложение не может его прочитать, только подписывать.

export type Alg = 'ed25519' | 'p256';
export interface IdentityKey { alg: Alg; publicKey: string; privateKey: CryptoKey }

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64u(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(p);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const algParams = (alg: Alg) => (alg === 'ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' });
const signParams = (alg: Alg) => (alg === 'ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' });

export async function generateIdentityKey(prefer: Alg = 'ed25519', extractable = false): Promise<IdentityKey> {
  const order: Alg[] = prefer === 'ed25519' ? ['ed25519', 'p256'] : ['p256'];
  let lastErr: unknown;
  for (const alg of order) {
    try {
      const pair = (await subtle().generateKey(algParams(alg), extractable, ['sign', 'verify'])) as CryptoKeyPair;
      const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
      return { alg, publicKey: `${alg}:${b64u(raw)}`, privateKey: pair.privateKey };
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Подписи не поддерживаются этим браузером');
}

export const PUBLIC_KEY_RE = /^(ed25519|p256):[A-Za-z0-9_-]{40,120}$/;

function splitKey(publicKey: string): { alg: Alg; raw: Uint8Array } | null {
  if (!PUBLIC_KEY_RE.test(publicKey)) return null;
  const [alg, body] = publicKey.split(':') as [Alg, string];
  try {
    const raw = fromB64u(body);
    return (alg === 'ed25519' && raw.length === 32) || (alg === 'p256' && raw.length === 65) ? { alg, raw } : null;
  } catch { return null; }
}

export async function signText(key: Pick<IdentityKey, 'alg' | 'privateKey'>, text: string): Promise<string> {
  const sig = await subtle().sign(signParams(key.alg), key.privateKey, new TextEncoder().encode(text));
  return b64u(new Uint8Array(sig));
}

export async function verifyText(publicKey: string, text: string, sig: string): Promise<boolean> {
  const k = splitKey(publicKey);
  if (!k || typeof sig !== 'string' || sig.length > 200) return false;
  try {
    const pub = await subtle().importKey('raw', k.raw as BufferSource, algParams(k.alg), false, ['verify']);
    return await subtle().verify(signParams(k.alg), pub, fromB64u(sig) as BufferSource, new TextEncoder().encode(text));
  } catch { return false; }
}

const sha256 = async (text: string) => new Uint8Array(await subtle().digest('SHA-256', new TextEncoder().encode(text)));

/** Стабильная личность выводится из ключа: подделать чужой profileId, не имея ключа, нельзя. */
export async function profileIdFor(publicKey: string): Promise<string> {
  return 'p_' + b64u(await sha256('profile|' + publicKey)).slice(0, 22);
}

/** Короткий отпечаток ключа для ручной сверки: «4F2A-91CC-07DE-B3A8». */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const h = [...(await sha256('fp|' + publicKey)).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return h.match(/.{4}/g)!.join('-');
}

/** Каноничный JSON: ключи по алфавиту, без пробелов. Подпись считается именно по нему. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

// ---------- переносимый ключ: слепок под паролем ----------
// Приватный ключ нельзя прочитать, но при создании профиля он на мгновение существует
// в экспортируемом виде: из него снимается JWK, шифруется AES-GCM ключом, выведенным
// из пароля (PBKDF2), и в таком виде отправляется синхронизацией. На втором устройстве
// тот же пароль расшифровывает слепок, а сам ключ там снова становится неэкспортируемым.
// Через сеть и в базе сервера ходит только шифрованный слепок: без пароля он бесполезен.
export interface WrappedKey { v: 1; alg: Alg; salt: string; iters: number; iv: string; ct: string }

// 310 тысяч итераций PBKDF2 — рекомендация OWASP для SHA-256 (2023): поднять цену
// перебора слабых паролей тем, у кого есть копия базы сервера.
export const WRAP_ITERS = 310_000;
const enc = new TextEncoder();

async function deriveWrapKey(pass: string, salt: Uint8Array, iters: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: iters, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Снимает JWK с ЭКСПОРТИРУЕМОГО ключа и шифрует его паролем. Обычный ключ профиля неэкспортируемый. */
export async function wrapIdentityKey(privateKey: CryptoKey, alg: Alg, pass: string): Promise<WrappedKey> {
  const jwk = await subtle().exportKey('jwk', privateKey);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWrapKey(pass, salt, WRAP_ITERS);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(JSON.stringify(jwk)) as BufferSource));
  return { v: 1, alg, salt: b64u(salt), iters: WRAP_ITERS, iv: b64u(iv), ct: b64u(ct) };
}

/** Расшифровывает слепок и возвращает ключ только для подписи — снова неэкспортируемый. */
export async function unwrapIdentityKey(w: WrappedKey, pass: string): Promise<CryptoKey> {
  if (w.v !== 1) throw new Error('Неизвестная версия слепка ключа');
  const salt = fromB64u(w.salt), iv = fromB64u(w.iv);
  const key = await deriveWrapKey(pass, salt, w.iters);
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, fromB64u(w.ct) as BufferSource));
  } catch {
    throw new Error('Неверный пароль профиля');
  }
  const jwk = JSON.parse(new TextDecoder().decode(pt)) as JsonWebKey;
  return subtle().importKey('jwk', jwk, algParams(w.alg), false, ['sign']);
}
