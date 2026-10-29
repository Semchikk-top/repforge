// Каталог магазина. Цены в монетах; у тренировки в среднем выходит 30–60 монет.
import type { Slot } from './types';

interface Base { id: string; slot: Slot; name: string; desc: string; price: number; anim?: boolean; requires?: string }
export interface AvatarItem extends Base { slot: 'avatar'; glyph: string; c1: string; c2: string; fg: string; motion?: 'pulse' | 'flicker' | 'spin' | 'beat' | 'blink' | 'float'; letter?: boolean }
export interface FrameItem extends Base { slot: 'frame'; css: string }
export interface BannerItem extends Base { slot: 'banner'; bg: string }
export interface AccentItem extends Base { slot: 'accent'; dark: string; light: string }
export interface TitleItem extends Base { slot: 'title'; text: string }
export type ShopItem = AvatarItem | FrameItem | BannerItem | AccentItem | TitleItem;

export const DEFAULTS: Record<Slot, string> = { avatar: 'av-letter', frame: 'fr-none', banner: 'bn-default', accent: 'ac-default', title: 'tt-none' };

const av = (id: string, name: string, desc: string, price: number, glyph: string, c1: string, c2: string, fg = '#fff', extra: Partial<AvatarItem> = {}): AvatarItem =>
  ({ id, slot: 'avatar', name, desc, price, glyph, c1, c2, fg, ...extra, anim: !!extra.motion });

export const ITEMS: ShopItem[] = [
  // аватары
  av('av-letter', 'Инициал', 'Первая буква имени. Бесплатно.', 0, 'user', '#3a4658', '#222a35', '#e8e6e1', { letter: true }),
  av('av-plate', 'Блин', 'Классика зала. Бесплатно.', 0, 'plate', '#3b4a63', '#1f2733', '#d6dde8'),
  av('av-kettle', 'Гиря', 'Тяжёлая и честная.', 120, 'kettle', '#4a5a3a', '#26301d', '#d9e8b5'),
  av('av-medal', 'Медаль', 'Для тех, кто ценит награды.', 200, 'medal', '#7a5a1c', '#3b2a0a', '#ffe08a'),
  av('av-bolt', 'Молния', 'Пульсирует, если тапнуть.', 280, 'bolt', '#3b4fd0', '#1a1f5a', '#ffe66b', { motion: 'pulse' }),
  av('av-flame', 'Огонь', 'Мерцает без остановки.', 420, 'flame', '#d4521a', '#6a1c08', '#ffd27a', { motion: 'flicker' }),
  av('av-spin', 'Вращающийся блин', 'Крутится сам.', 600, 'plate', '#1f8a8a', '#0b3b4a', '#b9fff5', { motion: 'spin' }),
  av('av-heart', 'Пульс', 'Бьётся как сердце.', 520, 'heart', '#c8324f', '#5a0f20', '#ffd0d8', { motion: 'beat' }),
  av('av-robot', 'Робот', 'Моргает. Иногда.', 900, 'robot', '#4a5a7a', '#1a2132', '#9be7ff', { motion: 'blink' }),
  av('av-crown', 'Корона', 'Парит над остальными.', 1500, 'crown', '#8a5cd6', '#2b1560', '#ffe9a8', { motion: 'float' }),
  av('av-dev', 'Консоль', 'Только для разработчика.', 0, 'code', '#102a1a', '#050f09', '#6dff9c', { motion: 'blink', requires: 'dev' }),
  // рамки
  { id: 'fr-none', slot: 'frame', name: 'Без рамки', desc: 'Минимализм.', price: 0, css: 'fr-none' },
  { id: 'fr-ring', slot: 'frame', name: 'Кольцо', desc: 'Цвет берётся из выбранного акцента.', price: 80, css: 'fr-ring' },
  { id: 'fr-gold', slot: 'frame', name: 'Золото', desc: 'Тяжёлая золотая оправа.', price: 220, css: 'fr-gold' },
  { id: 'fr-neon', slot: 'frame', name: 'Неон', desc: 'Дышит светом.', price: 380, css: 'fr-neon', anim: true },
  { id: 'fr-rainbow', slot: 'frame', name: 'Радуга', desc: 'Постоянно перетекает.', price: 750, css: 'fr-rainbow', anim: true },
  { id: 'fr-outstanding', slot: 'frame', name: 'Выдающийся', desc: 'Выдаётся за жим 100 кг.', price: 0, css: 'fr-gold', requires: 'bench100' },
  // фоны шапки профиля
  { id: 'bn-default', slot: 'banner', name: 'Стандарт', desc: 'Спокойный фон.', price: 0, bg: 'linear-gradient(135deg, var(--surface-2), var(--surface))' },
  { id: 'bn-carbon', slot: 'banner', name: 'Карбон', desc: 'Плетение углеволокна.', price: 150, bg: 'repeating-linear-gradient(45deg, #1a1d22 0 6px, #252a31 6px 12px)' },
  { id: 'bn-dusk', slot: 'banner', name: 'Закат', desc: 'После хорошей тренировки.', price: 180, bg: 'linear-gradient(135deg, #3a2a5c, #c2566b 60%, #f0a35e)' },
  { id: 'bn-ocean', slot: 'banner', name: 'Океан', desc: 'Прохладная глубина.', price: 180, bg: 'linear-gradient(135deg, #0f3057, #1b6ca8 55%, #4cc3d9)' },
  { id: 'bn-forest', slot: 'banner', name: 'Лес', desc: 'Для пробежек.', price: 180, bg: 'linear-gradient(135deg, #10301f, #2e7d4f 60%, #a5d36a)' },
  { id: 'bn-aurora', slot: 'banner', name: 'Северное сияние', desc: 'Медленно переливается.', price: 650, bg: 'linear-gradient(120deg, #0b3d3a, #3b6fd8, #9a4ad8, #2ec4a5, #0b3d3a)', anim: true },
  // цвет приложения
  { id: 'ac-default', slot: 'accent', name: 'Янтарь', desc: 'Родной цвет приложения.', price: 0, dark: '#d9a441', light: '#92600a' },
  { id: 'ac-blue', slot: 'accent', name: 'Сапфир', desc: 'Меняет акцент во всём приложении.', price: 150, dark: '#6aa5e8', light: '#2f64a8' },
  { id: 'ac-green', slot: 'accent', name: 'Изумруд', desc: 'Меняет акцент во всём приложении.', price: 150, dark: '#6fc28a', light: '#2e7d4f' },
  { id: 'ac-red', slot: 'accent', name: 'Рубин', desc: 'Меняет акцент во всём приложении.', price: 150, dark: '#e0786b', light: '#b3362a' },
  { id: 'ac-violet', slot: 'accent', name: 'Аметист', desc: 'Меняет акцент во всём приложении.', price: 200, dark: '#a98be8', light: '#6a45b8' },
  { id: 'ac-pink', slot: 'accent', name: 'Розовый кварц', desc: 'Меняет акцент во всём приложении.', price: 200, dark: '#e48ab9', light: '#b0407f' },
  { id: 'ac-cyan', slot: 'accent', name: 'Бирюза', desc: 'Меняет акцент во всём приложении.', price: 200, dark: '#58c7d4', light: '#177a86' },
  // звания под именем
  { id: 'tt-none', slot: 'title', name: 'По уровню', desc: 'Звание зависит от уровня.', price: 0, text: '' },
  { id: 'tt-iron', slot: 'title', name: 'Железный', desc: 'Звание под именем.', price: 100, text: 'Железный' },
  { id: 'tt-heavy', slot: 'title', name: 'Любитель тяжестей', desc: 'Звание под именем.', price: 150, text: 'Любитель тяжестей' },
  { id: 'tt-night', slot: 'title', name: 'Ночной зверь', desc: 'Звание под именем.', price: 220, text: 'Ночной зверь' },
  { id: 'tt-nodays', slot: 'title', name: 'Без выходных', desc: 'Звание под именем.', price: 300, text: 'Без выходных' },
  { id: 'tt-legend', slot: 'title', name: 'Легенда зала', desc: 'Звание под именем.', price: 1000, text: 'Легенда зала' },
  { id: 'tt-dev', slot: 'title', name: 'Разработчик', desc: 'Только для разработчика.', price: 0, text: 'Разработчик', requires: 'dev' }
];

export const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
export const itemsOf = (slot: Slot): ShopItem[] => ITEMS.filter((i) => i.slot === slot);
/** Предмет, который нельзя купить: даётся за достижение. */
export const isReward = (i: ShopItem): boolean => !!i.requires;
export const isFree = (i: ShopItem): boolean => i.price === 0 && !i.requires;

export const SLOT_LABELS: Record<Slot, string> = { avatar: 'Аватары', frame: 'Рамки', banner: 'Фоны', accent: 'Цвета', title: 'Звания' };
