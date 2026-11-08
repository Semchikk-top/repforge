// Маленький набор значков в стиле остального приложения (контурные, 24×24).
import type { ReactNode } from 'react';

const G: Record<string, ReactNode> = {
  dumbbell: <path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12" />,
  kettle: <><path d="M8.5 9a3.5 3.5 0 0 1 7 0" /><path d="M7 20h10a2 2 0 0 0 2-2c0-4-3-8-7-8s-7 4-7 8a2 2 0 0 0 2 2z" /></>,
  plate: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /></>,
  bolt: <path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z" />,
  flame: <path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z" />,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  robot: <><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 8V4M9 13h.01M15 13h.01M9 16h6" /></>,
  star: <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z" />,
  crown: <path d="M4 18h16M5 18L4 8l5 4 3-6 3 6 5-4-1 10" />,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" /></>,
  code: <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />,
  pulse: <path d="M3 12h4l2-6 4 12 2-6h6" />,
  mountain: <path d="M3 19l6-11 4 7 3-4 5 8H3z" />,
  medal: <><circle cx="12" cy="15" r="5" /><path d="M8.5 3L12 10l3.5-7M12 12.5v5" /></>,
  trophy: <path d="M8 4h8v5a4 4 0 0 1-8 0V4zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 20h8" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  coin: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.6h-3a1.8 1.8 0 0 0 0 3.6H15" /></>,
  infinity: <path d="M12 12c-2-3-3-4-5-4a4 4 0 0 0 0 8c2 0 3-1 5-4s3-4 5-4a4 4 0 0 1 0 8c-2 0-3-1-5-4z" />,
  gift: <><rect x="3" y="9" width="18" height="11" rx="1" /><path d="M12 9v11M3 13h18M12 9c-3-5-6-1-3 0M12 9c3-5 6-1 3 0" /></>,
  bag: <><path d="M5 8h14l-1 12H6L5 8z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></>,
  layers: <path d="M12 4l9 5-9 5-9-5 9-5zM3 14l9 5 9-5" />,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" /></>,
  twin: <path d="M5 8h5M14 8h5M7.5 8v8M16.5 8v8M5 16h5M14 16h5" />,
  rocket: <><path d="M12 3c3 2 5 5 5 9l-2 4H9l-2-4c0-4 2-7 5-9z" /><circle cx="12" cy="10" r="1.5" /><path d="M9 16l-3 3M15 16l3 3M12 17v4" /></>,
  diamond: <path d="M6 4h12l4 6-10 11L2 10l4-6zM2 10h20M9 4l3 6 3-6M12 21l-3-11M12 21l3-11" />,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></>,
  snowflake: <path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 2 3-2M9 20l3-2 3 2" />,
  ghost: <><path d="M5 20V11a7 7 0 0 1 14 0v9l-3-2-2 2-2-2-2 2-2-2-3 2z" /><path d="M9.5 11h.01M14.5 11h.01" /></>
};

export type GlyphName = keyof typeof G;

export function Glyph({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {G[name] ?? G.star}
    </svg>
  );
}
