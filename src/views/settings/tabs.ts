// Вкладки настроек. Маршрут: #/settings/<id>. Без id открывается «Общие».
export const SETTINGS_TABS = [
  { id: 'general', label: 'Общие' },
  { id: 'training', label: 'Тренировка' },
  { id: 'voice', label: 'Звук' },
  { id: 'data', label: 'Данные' },
  { id: 'server', label: 'Сервер' },
  { id: 'about', label: 'О приложении' }
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

export function parseTab(seg: string | undefined): SettingsTabId {
  return SETTINGS_TABS.find((t) => t.id === seg)?.id ?? 'general';
}
