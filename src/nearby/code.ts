// Код комнаты: 8 символов без похожих 0/O и 1/I, формат XXXX-XXXX (тот же алфавит, что у релея).
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** «k7m4 p2qx» → «K7M4-P2QX»; null, если так записать код нельзя. */
export function normalizeCode(input: string): string | null {
  const s = (input ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== 8) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Подсказка при вводе: оставляет допустимые символы и ставит дефис после четвёртого. */
export function formatCodeInput(input: string): string {
  const s = (input ?? '').toUpperCase().split('').filter((ch) => CODE_ALPHABET.includes(ch)).slice(0, 8).join('');
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}
