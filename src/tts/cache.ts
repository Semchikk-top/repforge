// Манифест готовых фраз на устройстве: voiceId + paramsHash + textKey → файл в AudioStore.
// Хранится в localStorage этого устройства (не синхронизируется и не попадает в экспорт): это кеш, а не данные пользователя.
// Чтение в горячем пути — из памяти, без сети и без обращения к диску.

export interface ManifestEntry { name: string; hash: string; ext: string; bytes: number; duration?: number | null }
interface Data { v: 1; paramsHash: string; entries: Record<string, ManifestEntry> }
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export const MANIFEST_KEY = 'repforge:tts-manifest';

/** Быстрый нестойкий хэш строки (cyrb53): нужен только как короткий ключ, не для защиты. */
export function shortHash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Ключ фразы: пробелы и переводы строк не различаются. Допустим в API сервера (буквы, цифры, «-»). */
export const normalizeText = (t: string): string => t.replace(/\s+/g, ' ').trim();
export const textKey = (t: string): string => 't-' + shortHash(normalizeText(t));

export interface SynthParams { temperature: number; topP: number; repetitionPenalty: number; chunkLength: number; seed: number | null }
/** Хэш параметров синтеза и формата: сменились — пак устарел. */
export const paramsHashOf = (p: SynthParams, format: string): string =>
  shortHash(JSON.stringify([format, p.temperature, p.topP, p.repetitionPenalty, p.chunkLength, p.seed]));

const empty = (): Data => ({ v: 1, paramsHash: '', entries: {} });

export class Manifest {
  private data: Data | null = null;
  constructor(private kv: KV | null) {}

  private load(): Data {
    if (this.data) return this.data;
    try {
      const raw = this.kv?.getItem(MANIFEST_KEY);
      const d = raw ? (JSON.parse(raw) as Data) : null;
      this.data = d && d.v === 1 && typeof d.entries === 'object' && d.entries ? d : empty();
    } catch { this.data = empty(); }
    return this.data;
  }
  private save(): void {
    try { this.kv?.setItem(MANIFEST_KEY, JSON.stringify(this.data)); } catch { /* переполнено: пак живёт до перезапуска */ }
  }
  private key(voiceId: string, paramsHash: string, text: string): string { return `${voiceId}|${paramsHash}|${textKey(text)}`; }

  get paramsHash(): string { return this.load().paramsHash; }
  setParamsHash(h: string): void { const d = this.load(); if (d.paramsHash !== h) { d.paramsHash = h; this.save(); } }

  /** Запись для фразы при текущих голосе и параметрах; без параметров синтеза пак считается пустым. */
  lookup(voiceId: string, text: string): ManifestEntry | null {
    const d = this.load();
    if (!voiceId || !d.paramsHash) return null;
    return d.entries[this.key(voiceId, d.paramsHash, text)] ?? null;
  }
  has(voiceId: string, text: string): boolean { return this.lookup(voiceId, text) !== null; }
  set(voiceId: string, text: string, e: ManifestEntry): void {
    const d = this.load();
    d.entries[this.key(voiceId, d.paramsHash, text)] = e;
    this.save();
  }
  /** Записи актуального набора (для счётчиков). */
  currentEntries(voiceId: string): ManifestEntry[] {
    const d = this.load();
    const prefix = `${voiceId}|${d.paramsHash}|`;
    return Object.entries(d.entries).filter(([k]) => k.startsWith(prefix)).map(([, e]) => e);
  }
  /** Все файлы, на которые есть ссылки. */
  referenced(): Set<string> { return new Set(Object.values(this.load().entries).map((e) => e.name)); }

  /** Убрать записи чужих голосов и устаревших параметров. Возвращает имена файлов, которые больше никому не нужны. */
  invalidateExcept(voiceId: string): string[] {
    const d = this.load();
    const keep = `${voiceId}|${d.paramsHash}|`;
    const dropped = new Set<string>();
    for (const [k, e] of Object.entries(d.entries)) if (!k.startsWith(keep)) { dropped.add(e.name); delete d.entries[k]; }
    const still = this.referenced();
    this.save();
    return [...dropped].filter((n) => !still.has(n));
  }
  /** Убрать все записи голоса (голос удалён). */
  removeVoice(voiceId: string): string[] {
    const d = this.load();
    const dropped = new Set<string>();
    for (const [k, e] of Object.entries(d.entries)) if (k.startsWith(voiceId + '|')) { dropped.add(e.name); delete d.entries[k]; }
    const still = this.referenced();
    this.save();
    return [...dropped].filter((n) => !still.has(n));
  }
  clear(): string[] {
    const names = [...this.referenced()];
    this.data = { ...empty(), paramsHash: this.load().paramsHash };
    this.save();
    return names;
  }
}

function browserKV(): KV | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
let shared: Manifest | null = null;
/** Общий манифест приложения. */
export function manifest(): Manifest { return (shared ??= new Manifest(browserKV())); }
export function setManifestForTests(m: Manifest | null): void { shared = m; }
