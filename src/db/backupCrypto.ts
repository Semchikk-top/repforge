// Шифрование резервных копий. Два режима:
//  • password — ключ из пароля (PBKDF2 + AES-GCM): для копий, которые пользователь уносит с телефона. Забытый пароль
//    восстановить нельзя, это сознательное свойство;
//  • key — случайный ключ из Keystore/Keychain: для автокопий внутри приложения, пароль не нужен.
import { b64u, fromB64u, WRAP_ITERS } from '../social/crypto';

export interface BackupEnvelope {
  app: 'repforge'; kind: 'backup'; v: 1;
  kdf: 'pbkdf2' | 'raw';
  salt?: string; iters?: number;
  iv: string; ct: string;
}
export type BackupSecret = { kind: 'password'; pass: string } | { kind: 'key'; key: string };

const AAD = new TextEncoder().encode('repforge-backup-v1');
const subtle = () => globalThis.crypto.subtle;
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Случайный 256-битный ключ для автокопий (в base64url). */
export const newBackupKey = (): string => b64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));

/** Это зашифрованная копия? Обычный JSON-экспорт и любой мусор дают null. */
export function parseEnvelope(text: string): BackupEnvelope | null {
  if (text.length > 200_000_000 || text.charCodeAt(0) !== 0x7b /* { */) return null;
  try {
    const o = JSON.parse(text) as Partial<BackupEnvelope>;
    if (o.app === 'repforge' && o.kind === 'backup' && o.v === 1 && (o.kdf === 'pbkdf2' || o.kdf === 'raw') && typeof o.iv === 'string' && typeof o.ct === 'string') return o as BackupEnvelope;
  } catch { /* не JSON */ }
  return null;
}

async function deriveKey(secret: BackupSecret, kdf: BackupEnvelope['kdf'], salt?: Uint8Array, iters?: number): Promise<CryptoKey> {
  if (secret.kind === 'key') {
    if (kdf !== 'raw') throw new Error('Эта копия зашифрована паролем, а не ключом приложения');
    return subtle().importKey('raw', buf(fromB64u(secret.key)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  if (kdf !== 'pbkdf2' || !salt || !iters) throw new Error('Эта копия зашифрована ключом приложения, пароль к ней не подходит');
  const base = await subtle().importKey('raw', new TextEncoder().encode(secret.pass), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt: buf(salt), iterations: iters, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackup(plain: string, secret: BackupSecret, iters: number = WRAP_ITERS): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const salt = secret.kind === 'password' ? globalThis.crypto.getRandomValues(new Uint8Array(16)) : undefined;
  const key = await deriveKey(secret, secret.kind === 'password' ? 'pbkdf2' : 'raw', salt, iters);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(AAD) }, key, new TextEncoder().encode(plain)));
  const env: BackupEnvelope = {
    app: 'repforge', kind: 'backup', v: 1, kdf: secret.kind === 'password' ? 'pbkdf2' : 'raw',
    ...(salt ? { salt: b64u(salt), iters } : {}), iv: b64u(iv), ct: b64u(ct)
  };
  return JSON.stringify(env);
}

export async function decryptBackup(text: string, secret: BackupSecret): Promise<string> {
  const env = parseEnvelope(text);
  if (!env) throw new Error('Это не зашифрованная копия');
  const key = await deriveKey(secret, env.kdf, env.salt ? fromB64u(env.salt) : undefined, env.iters);
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: buf(fromB64u(env.iv)), additionalData: buf(AAD) }, key, buf(fromB64u(env.ct)));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error(secret.kind === 'password' ? 'Неверный пароль или файл повреждён' : 'Не удалось расшифровать копию: ключ приложения другой или файл повреждён');
  }
}
