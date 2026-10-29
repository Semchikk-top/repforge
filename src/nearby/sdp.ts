// Всё, что связано с текстом SDP: отпечаток DTLS, код сверки (SAS) и фильтр чужих адресов.

/** Первый DTLS-отпечаток из SDP в виде «sha-256 aa:bb:…»; null, если его нет. */
export function extractFingerprint(sdp: string): string | null {
  const m = /^a=fingerprint:([\w-]+) ([0-9A-Fa-f:]+)\s*$/m.exec(sdp);
  return m ? `${m[1].toLowerCase()} ${m[2].toLowerCase()}` : null;
}

/** Длина кода сверки. Четырёх цифр мало: подставить сертификат под нужные 4 цифры можно перебором за секунды. */
export const SAS_DIGITS = 6;

/**
 * Код сверки: SHA-256 от двух отпечатков (по алфавиту, чтобы у обоих вышло одно и то же), первые 32 бита по модулю 10^6.
 * Если релей подменит SDP, отпечатки у друзей разойдутся и коды на экранах не совпадут.
 */
export function channelBinding(localSdp: string, remoteSdp: string): string {
  const a = extractFingerprint(localSdp);
  const b = extractFingerprint(remoteSdp);
  if (!a || !b) throw new Error('В SDP нет отпечатка DTLS');
  return [a, b].sort().join('|');
}

export async function computeSas(localSdp: string, remoteSdp: string, digits = SAS_DIGITS): Promise<string> {
  const data = new TextEncoder().encode(channelBinding(localSdp, remoteSdp));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const n = (((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) % 10 ** digits;
  return String(n).padStart(digits, '0');
}

/** 482913 → «482 913» */
export function formatSas(sas: string): string {
  const half = Math.ceil(sas.length / 2);
  return sas.length > 3 ? `${sas.slice(0, half)} ${sas.slice(half)}` : sas;
}

/** Адрес из локальной сети, loopback, link-local, CGNAT/Tailscale или mDNS-имя «….local». */
export function isLocalAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254)
      || (x === 100 && y >= 64 && y <= 127) || (x === 192 && y === 0);
  }
  if (a.includes(':')) return a === '::1' || /^fe[89ab]/.test(a) || /^f[cd]/.test(a);
  return false;
}

/**
 * Убирает из чужого SDP кандидатов с публичными адресами: комната работает только в локальной сети,
 * и мы не хотим, чтобы телефон стучался по произвольным адресам из присланного релеем текста.
 */
export function filterRemoteSdp(sdp: string): string {
  return sdp.split(/\r?\n/).filter((line) => {
    if (!line.startsWith('a=candidate:')) return true;
    const parts = line.split(' ');
    const typ = parts[parts.indexOf('typ') + 1];
    if (typ === 'srflx' || typ === 'relay' || typ === 'prflx') return false;
    return parts[4] !== undefined && isLocalAddress(parts[4]);
  }).join('\r\n');
}
