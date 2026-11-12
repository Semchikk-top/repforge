import type { ReactNode } from 'react';

const base = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const mk = (d: ReactNode) => ({ size = 24 }: { size?: number }) => (
  <svg {...base} width={size} height={size} aria-hidden="true">{d}</svg>
);

export const IconCalendar = mk(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>);
export const IconDumbbell = mk(<><path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12" /></>);
export const IconChart = mk(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>);
export const IconList = mk(<><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>);
export const IconGear = mk(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
export const IconCheck = mk(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IconPlus = mk(<path d="M12 5v14M5 12h14" />);
export const IconMinus = mk(<path d="M5 12h14" />);
export const IconClose = mk(<path d="M6 6l12 12M18 6L6 18" />);
export const IconChevL = mk(<path d="M15 5l-7 7 7 7" />);
export const IconChevR = mk(<path d="M9 5l7 7-7 7" />);
export const IconTrash = mk(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>);
export const IconBack = mk(<path d="M15 5l-7 7 7 7" />);
export const IconSpark = mk(<><path d="M11 3l1.9 5.6L18.5 10.5l-5.6 1.9L11 18l-1.9-5.6L3.5 10.5l5.6-1.9L11 3z" /><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8L19 15z" /></>);
export const IconSend = mk(<path d="M12 19V5M6 11l6-6 6 6" />);
export const IconStop = mk(<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />);
export const IconNearby = mk(<><circle cx="8" cy="8" r="3" /><path d="M2.5 19.5c0-3.2 2.4-5.5 5.5-5.5s5.5 2.3 5.5 5.5" /><circle cx="17.5" cy="9" r="2.4" /><path d="M16.2 14.3c3.1-.2 5.3 1.6 5.3 4.4" /></>);
export const IconSwap = mk(<><path d="M4 8h14M14 4l4 4-4 4" /><path d="M20 16H6M10 12l-4 4 4 4" /></>);
export const IconGrip = mk(<path d="M5 8h14M5 12h14M5 16h14" />);
export const IconArrowUp = mk(<path d="M12 19V5M6 11l6-6 6 6" />);
export const IconArrowDown = mk(<path d="M12 5v14M6 13l6 6 6-6" />);
export const IconInfo = mk(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.6h.01" /></>);
