// «Что нового»: короткие записи по версиям и чистая логика выбора того, что показать после обновления.
export interface WhatsNewEntry { version: string; title: string; items: string[] }

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '1.2.0',
    title: 'Подстройка нагрузки, интервалы и надёжное восстановление',
    items: [
      'Нагрузка по состоянию: по чек-ину, нагрузке за неделю и застою приложение предлагает снизить вес на 5–10% или убрать подход. Кнопка «Сделать легче» меняет только тренировку сегодняшнего дня, и только по нажатию.',
      'Интервалы для бега, ходьбы и велосипеда: разминка, повторы работы и отдыха, заминка, цели по темпу или пульсовой зоне, голос и вибрация, шаблоны.',
      'Локальный ассистент (Ollama) больше не обрывает ответы: используется родной интерфейс Ollama с достаточным контекстом, а обрезанный ответ помечается явно.',
      'Восстановление из копии начинается с предпросмотра: что добавится, что заменится и где данные на устройстве новее. Битая копия или копия чужой версии ничего не запишет.',
      'Перед обновлением схемы базы приложение само сохраняет снимок данных.',
      'Если сервер на ПК старее приложения, в настройках появится подсказка обновить его.',
      'Отозванное устройство можно вернуть кнопкой «Восстановить» в течение суток, потом его карточка исчезает.'
    ]
  }
];

const parts = (v: string): number[] => v.replace(/-.*$/, '').split('.').map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0));
export function compareVersions(a: string, b: string): number {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * Что показать после обновления. lastSeen — версия, которую пользователь уже видел (null: неизвестно).
 * Показываются записи новее lastSeen и не новее текущей версии, свежие первыми, не больше трёх.
 * Если lastSeen неизвестна, показывается только запись текущей версии.
 */
export function entriesToShow(lastSeen: string | null, current: string, entries: WhatsNewEntry[] = WHATS_NEW): WhatsNewEntry[] {
  const pick = entries.filter((e) => compareVersions(e.version, current) <= 0 && (lastSeen === null ? compareVersions(e.version, current) === 0 : compareVersions(e.version, lastSeen) > 0));
  return pick.sort((a, b) => compareVersions(b.version, a.version)).slice(0, 3);
}
