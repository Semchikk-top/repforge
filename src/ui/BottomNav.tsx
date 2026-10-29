import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { Avatar } from '../game/Avatar';
import { useGame } from '../game/hooks';
import { go } from '../state/router';
import { useSyncBadge } from '../sync/useSyncBadge';
import { IconCalendar, IconChart, IconDumbbell, IconList } from './Icons';

const TABS = [
  { key: 'calendar', label: 'Календарь', Icon: IconCalendar },
  { key: 'workout', label: 'Тренировка', Icon: IconDumbbell },
  { key: 'stats', label: 'Аналитика', Icon: IconChart },
  { key: 'exercises', label: 'Упражнения', Icon: IconList },
  { key: 'profile', label: 'Профиль', Icon: null }
] as const;

export function BottomNav({ current }: { current: string }) {
  const hasActive = useLiveQuery(async () => (await db.workouts.where('status').equals('active').filter((w) => !w.deletedAt).count()) > 0, [], false);
  const badge = useSyncBadge();
  const g = useGame();
  const idx = TABS.findIndex((t) => t.key === current);
  return (
    <nav className="nav" aria-label="Основная навигация">
      <div className="nav-inner">
        <span className="nav-ind" style={{ transform: `translateX(${Math.max(idx, 0) * 100}%)`, opacity: idx < 0 ? 0 : 1 }} aria-hidden="true" />
        {TABS.map(({ key, label, Icon }) => (
          <button key={key} className={current === key ? 'on' : ''} onClick={() => go(key)} aria-current={current === key ? 'page' : undefined}>
            {Icon ? <Icon /> : <Avatar avatarId={g.equipped.avatar} frameId={g.equipped.frame} name={g.name} size={26} />}
            <span>{label}</span>
            {key === 'workout' && hasActive && <span className="dot" aria-label="Идёт тренировка" />}
            {key === 'profile' && badge && <span className={'nav-badge' + (badge.warn ? ' warn' : '')} role="status" aria-label={badge.label}>{badge.text}</span>}
          </button>
        ))}
      </div>
    </nav>
  );
}
