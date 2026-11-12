// Числа словами для Fish: движок плохо читает цифры по-русски («120 метров», «5,2 километра»), поэтому в синтез
// уходит текст, где числа уже записаны словами. Это касается только готовых фраз (маршрут, зоны, студия):
// системный TTS читает цифры сам. Ограничение: целые до 999 999 и десятичные дроби с 1–2 знаками;
// порядковые вроде «5-я» и числа без единицы измерения читаются в мужском роде.

export type Gender = 'm' | 'f';

const ONES_M = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

function below1000(n: number, g: Gender): string[] {
  const out: string[] = [];
  if (n >= 100) out.push(HUNDREDS[Math.floor(n / 100)]);
  const r = n % 100;
  if (r >= 20) {
    out.push(TENS[Math.floor(r / 10)]);
    if (r % 10) out.push(unit(r % 10, g));
  } else if (r > 0) out.push(unit(r, g));
  return out;
}
const unit = (n: number, g: Gender): string => (g === 'f' && n === 1 ? 'одна' : g === 'f' && n === 2 ? 'две' : ONES_M[n]);

/** Склонение существительного при числе: 1 → one, 2–4 → few, остальное → many. */
export function pluralForm(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Целое число словами в нужном роде; null — вне поддерживаемого диапазона. */
export function numberWords(n: number, g: Gender = 'm'): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return null;
  if (n === 0) return ONES_M[0];
  const parts: string[] = [];
  const th = Math.floor(n / 1000);
  if (th) parts.push(...below1000(th, 'f'), pluralForm(th, 'тысяча', 'тысячи', 'тысяч'));
  parts.push(...below1000(n % 1000, g));
  return parts.join(' ');
}

const FRACTION = [
  { word: ['десятая', 'десятых', 'десятых'], digits: 1 },
  { word: ['сотая', 'сотых', 'сотых'], digits: 2 }
];

/** «5,2» → «пять целых две десятых». null — не поддерживается. */
export function decimalWords(int: string, frac: string): string | null {
  const f = FRACTION[frac.length - 1];
  if (!f) return null;
  const whole = parseInt(int, 10), fr = parseInt(frac, 10);
  const w = numberWords(whole, 'f'), fw = numberWords(fr, 'f');
  if (w === null || fw === null) return null;
  return `${w} ${pluralForm(whole, 'целая', 'целых', 'целых')} ${fw} ${pluralForm(fr, f.word[0], f.word[1], f.word[2])}`;
}

// Род числительного по слову после него.
const FEM_UNIT = /^(минут|секунд|зон|тысяч|попыт|остановк)/i;

const NUM = /(\d+)(?:[.,](\d+))?/g;

/** Заменяет числа в тексте словами. Порядковые («5-я», «1-го») и числа вне диапазона остаются как есть. */
export function spellNumbers(text: string): string {
  return text.replace(NUM, (match: string, int: string, frac: string | undefined, offset: number, whole: string) => {
    const after = whole.slice(offset + match.length);
    const before = whole.slice(0, offset);
    if (/^-[A-Za-zА-Яа-яЁё]/.test(after) || /[A-Za-zА-Яа-яЁё\d]$/.test(before) || /^[A-Za-z]/.test(after)) return match; // порядковые, коды вроде «A1»
    if (frac !== undefined) return decimalWords(int, frac) ?? match;
    const nextWord = (after.match(/^\s+([А-Яа-яЁё]+)/)?.[1]) ?? '';
    const g: Gender = FEM_UNIT.test(nextWord) ? 'f' : 'm';
    return numberWords(parseInt(int, 10), g) ?? match;
  });
}

export const hasDigits = (s: string): boolean => /\d/.test(s);
