// Большие сообщения (пакет снимков) режутся на куски: у DataChannel разных браузеров разные пределы размера.
export const CHUNK_SIZE = 12_000;
export const MAX_PARTS = 64;
export const MAX_TOTAL_CHARS = 400_000;

export interface Part { id: string; i: number; n: number; data: string }

export function splitMessage(id: string, text: string, size = CHUNK_SIZE): Part[] {
  const n = Math.max(1, Math.ceil(text.length / size));
  return Array.from({ length: n }, (_, i) => ({ id, i, n, data: text.slice(i * size, (i + 1) * size) }));
}

/** Собирает куски по порядку; лишнее, неупорядоченное и слишком большое отбрасывает. */
export class Reassembler {
  private id = '';
  private n = 0;
  private next = 0;
  private buf: string[] = [];
  private total = 0;

  /** Возвращает целое сообщение, когда пришёл последний кусок; 'bad' — нарушение протокола. */
  push(p: Part): string | null | 'bad' {
    if (p.i === 0) { this.id = p.id; this.n = p.n; this.next = 0; this.buf = []; this.total = 0; }
    if (p.id !== this.id || p.i !== this.next || p.n !== this.n || p.n < 1 || p.n > MAX_PARTS) return 'bad';
    this.total += p.data.length;
    if (this.total > MAX_TOTAL_CHARS) return 'bad';
    this.buf.push(p.data);
    this.next++;
    if (this.next < this.n) return null;
    const out = this.buf.join('');
    this.id = ''; this.buf = []; this.next = 0; this.n = 0;
    return out;
  }
}
