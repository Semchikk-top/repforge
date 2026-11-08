import { useMemo, useState, type CSSProperties } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { renameProfile } from '../social/store';
import { useProfile } from '../social/hooks';
import { currentStreakWeeks } from '../domain/analytics';
import type { Exercise, Workout } from '../domain/types';
import { formatNum } from '../lib';
import { ACHIEVEMENTS, TIER_LABELS, computeStats, type AchievementDef, type Stats } from '../game/achievements';
import { Avatar } from '../game/Avatar';
import { ITEM_BY_ID, SLOT_LABELS, itemsOf, type AccentItem, type AvatarItem, type BannerItem, type ShopItem, type TitleItem } from '../game/catalog';
import { Glyph } from '../game/glyphs';
import { useGame } from '../game/hooks';
import { buyItem, equipItem, setNickname } from '../game/store';
import { DEFAULTS } from '../game/catalog';
import { SLOTS, type Slot } from '../game/types';
import { go } from '../state/router';
import { IconGear } from '../ui/Icons';
import { useSyncBadge } from '../sync/useSyncBadge';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { SocialSection } from './SocialSection';

type Tab = 'overview' | 'awards' | 'shop' | 'friends';
const TABS: [Tab, string][] = [['overview', 'Обзор'], ['awards', 'Награды'], ['shop', 'Магазин'], ['friends', 'Друзья']];

const bannerOf = (id: string): BannerItem => (ITEM_BY_ID.get(id) as BannerItem) ?? (ITEM_BY_ID.get(DEFAULTS.banner) as BannerItem);
const fmtCoins = (n: number) => n.toLocaleString('ru-RU');

export function ProfileView({ initialTab }: { initialTab?: string }) {
  const g = useGame();
  const badge = useSyncBadge();
  const [tab, setTab] = useState<Tab>(TABS.some(([k]) => k === initialTab) ? (initialTab as Tab) : 'overview');
  const [rename, setRename] = useState(false);
  const workouts = useLiveQuery(() => db.workouts.toArray().then((w) => w.filter((x) => !x.deletedAt)), [], [] as Workout[]);
  const exercises = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[]);
  const stats = useMemo(() => computeStats(workouts, exercises, [...g.owned].filter((id) => { const i = ITEM_BY_ID.get(id); return !!i && i.price > 0; }).length), [workouts, exercises, g.owned]);

  const banner = bannerOf(g.equipped.banner);
  const title = (ITEM_BY_ID.get(g.equipped.title) as TitleItem | undefined)?.text || g.rank;
  const L = g.level;

  return (
    <div>
      <div className="profile-top">
        <button className="coin-chip" onClick={() => setTab('shop')} aria-label={`Монет: ${g.coins}. Открыть магазин`}>
          <Glyph name="coin" size={18} /><b>{fmtCoins(g.coins)}</b>
        </button>
        <button className="icon-btn settings-btn" onClick={() => go('settings')} aria-label="Настройки">
          <IconGear />
          {badge && <span className={'nav-badge' + (badge.warn ? ' warn' : '')} role="status" aria-label={badge.label}>{badge.text}</span>}
        </button>
      </div>

      <div className={'profile-hero' + (banner.anim ? ' anim' : '')} style={{ background: banner.bg }}>
        <Avatar avatarId={g.equipped.avatar} frameId={g.equipped.frame} name={g.name} size={92} interactive />
        <button className="profile-name" onClick={() => setRename(true)} aria-label="Сменить имя">{g.name}</button>
        <div className="profile-title">{title}</div>
        <div className="xp">
          <div className="xp-row"><span>Уровень <b>{L.level}</b></span><span>{L.atMax ? 'максимум' : `${formatNum(L.into)} / ${formatNum(L.span)} XP`}</span></div>
          <div className="xp-bar" role="progressbar" aria-valuenow={Math.round(L.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(L.progress * 100)}%` }} /></div>
        </div>
      </div>

      <div className="seg four" data-i={TABS.findIndex(([k]) => k === tab)} role="group" aria-label="Разделы профиля" style={{ marginTop: 16 }}>
        {TABS.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
      </div>

      <div key={tab} className="profile-body">
        {tab === 'overview' && <Overview stats={stats} workouts={workouts} xp={g.xp} earned={g.earned} spent={g.spent} unlocked={g.unlocked} onAwards={() => setTab('awards')} />}
        {tab === 'awards' && <Awards stats={stats} unlocked={g.unlocked} />}
        {tab === 'shop' && <Shop />}
        {tab === 'friends' && <SocialSection />}
      </div>
      {rename && <RenameSheet current={g.name} onClose={() => setRename(false)} />}
    </div>
  );
}

function RenameSheet({ current, onClose }: { current: string; onClose: () => void }) {
  const toast = useToast();
  const profile = useProfile();
  const [name, setName] = useState(current);
  const save = async () => {
    // если есть профиль для друзей, имя общее: иначе друзья увидели бы одно имя, а вы — другое
    if (profile) await renameProfile(name); else await setNickname(name);
    toast('Имя сохранено');
    onClose();
  };
  return (
    <Sheet title="Имя" onClose={onClose}>
      <div className="field"><label htmlFor="nick">Как вас показывать</label><input id="nick" className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></div>
      {profile && <p className="sub" style={{ marginBottom: 12 }}>Это то же имя, которое видят друзья.</p>}
      <button className="btn primary block" disabled={!name.trim()} onClick={save}>Сохранить</button>
    </Sheet>
  );
}

function Overview({ stats, workouts, xp, earned, spent, unlocked, onAwards }: { stats: Stats; workouts: Workout[]; xp: number; earned: number; spent: number; unlocked: Map<string, number>; onAwards: () => void }) {
  const streak = currentStreakWeeks(workouts);
  const next = useMemo(() => ACHIEVEMENTS
    .filter((a) => !a.secret && !unlocked.has(a.id) && a.measure)
    .map((a) => { const r = a.measure!(stats); return { a, r, p: r.cur / r.target }; })
    .sort((x, y) => y.p - x.p).slice(0, 3), [stats, unlocked]);
  const recent = useMemo(() => [...unlocked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => ACHIEVEMENTS.find((a) => a.id === id)!).filter(Boolean), [unlocked]);
  return (
    <>
      <div className="stat-grid">
        <Stat v={formatNum(stats.workouts)} l="трен. дней" />
        <Stat v={formatNum(Math.round(stats.volumeKg / 100) / 10)} l="тонн всего" />
        <Stat v={formatNum(stats.cardioKm)} l="км кардио" />
        <Stat v={String(streak)} l="недель подряд" />
        <Stat v={fmtCoins(xp)} l="опыта" />
        <Stat v={`${unlocked.size}/${ACHIEVEMENTS.length}`} l="достижений" />
      </div>

      {next.length > 0 && (
        <div className="section">
          <h2>Ближайшие цели</h2>
          {next.map(({ a, r }) => <AchRow key={a.id} a={a} unlocked={false} measure={r} />)}
        </div>
      )}
      {recent.length > 0 && (
        <div className="section">
          <h2>Недавно получено</h2>
          <div className="recent-row">{recent.map((a) => <span key={a.id} className={'ach-medal t-' + a.tier} title={a.title}><Glyph name={a.glyph} size={24} /></span>)}</div>
          <button className="btn small ghost" style={{ marginTop: 8 }} onClick={onAwards}>Все достижения</button>
        </div>
      )}
      <p className="sub" style={{ marginTop: 20 }}>Заработано монет: {fmtCoins(earned)}, потрачено: {fmtCoins(spent)}. Опыт и монеты начисляются за завершённые тренировки: чем больше объём (килограммы × повторы) и километры, тем больше награда.</p>
    </>
  );
}

const Stat = ({ v, l }: { v: string; l: string }) => <div className="stat"><div className="bignum" style={{ fontSize: 30 }}>{v}</div><div className="sub">{l}</div></div>;

function AchRow({ a, unlocked, measure, at }: { a: AchievementDef; unlocked: boolean; measure?: { cur: number; target: number }; at?: number }) {
  const hidden = a.secret && !unlocked;
  const pct = measure ? Math.min(100, Math.round((measure.cur / measure.target) * 100)) : 0;
  return (
    <div className={'ach' + (unlocked ? ' got' : '') + (hidden ? ' secret' : '')}>
      <span className={'ach-medal t-' + (hidden ? 'lock' : a.tier)}><Glyph name={hidden ? 'lock' : a.glyph} size={24} /></span>
      <div className="grow">
        <div className="title">{hidden ? 'Секретное достижение' : a.title}</div>
        <div className="meta">{hidden ? 'Условие скрыто, пока не получено' : a.desc}</div>
        {!unlocked && !hidden && measure && (
          <>
            <div className="ach-bar"><i style={{ width: `${pct}%` }} /></div>
            <div className="meta">{formatNum(Math.round(Math.min(measure.cur, measure.target) * 10) / 10)} / {formatNum(measure.target)}{a.unit ? ' ' + a.unit : ''}</div>
          </>
        )}
        {unlocked && at ? <div className="meta">Получено {new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</div> : null}
      </div>
      <div className="ach-reward"><Glyph name="coin" size={14} />{fmtCoins(a.reward)}</div>
    </div>
  );
}

function Awards({ stats, unlocked }: { stats: Stats; unlocked: Map<string, number> }) {
  const groups = useMemo(() => {
    const m = new Map<string, AchievementDef[]>();
    for (const a of ACHIEVEMENTS) m.set(a.group, [...(m.get(a.group) ?? []), a]);
    return [...m.entries()];
  }, []);
  return (
    <>
      <p className="sub" style={{ marginTop: 14 }}>Получено {unlocked.size} из {ACHIEVEMENTS.length}. Уровни: {Object.values(TIER_LABELS).join(', ')}. За каждое достижение дают монеты и столько же опыта.</p>
      {groups.map(([group, list]) => (
        <div className="section" key={group}>
          <h2>{group}</h2>
          {list.map((a) => <AchRow key={a.id} a={a} unlocked={unlocked.has(a.id)} at={unlocked.get(a.id)} measure={a.measure?.(stats)} />)}
        </div>
      ))}
    </>
  );
}

// ---------- магазин ----------
function Shop() {
  const g = useGame();
  const [slot, setSlot] = useState<Slot>('avatar');
  const [pick, setPick] = useState<ShopItem | null>(null);
  const list = itemsOf(slot);
  return (
    <>
      <div className="chips" style={{ marginTop: 14 }}>
        {SLOTS.map((s) => <button key={s} className={'chip' + (slot === s ? ' on' : '')} onClick={() => setSlot(s)}>{SLOT_LABELS[s]}</button>)}
      </div>
      <div className="shop-grid">
        {list.map((it) => {
          const owned = g.owned.has(it.id);
          const on = g.equipped[it.slot] === it.id;
          return (
            <button key={it.id} className={'shop-card' + (on ? ' on' : '')} onClick={() => setPick(it)}>
              <ItemPreview item={it} name={g.name} equipped={g.equipped} size={56} />
              <div className="title">{it.name}</div>
              <div className="meta">
                {on ? 'Надето' : owned ? 'Куплено' : it.requires ? 'За достижение' : <span className="price"><Glyph name="coin" size={14} />{fmtCoins(it.price)}</span>}
                {it.anim && !owned ? ' · анимация' : ''}
              </div>
            </button>
          );
        })}
      </div>
      {pick && <ItemSheet item={pick} onClose={() => setPick(null)} />}
    </>
  );
}

/** Предпросмотр предмета на фоне того, что уже надето. */
function ItemPreview({ item, name, equipped, size }: { item: ShopItem; name: string; equipped: Record<Slot, string>; size: number }) {
  if (item.slot === 'avatar' || item.slot === 'frame') {
    return <Avatar avatarId={item.slot === 'avatar' ? item.id : equipped.avatar} frameId={item.slot === 'frame' ? item.id : equipped.frame} name={name} size={size} />;
  }
  if (item.slot === 'banner') return <span className={'swatch wide' + ((item as BannerItem).anim ? ' anim' : '')} style={{ background: (item as BannerItem).bg, height: size * 0.7, width: size * 1.4 }} />;
  if (item.slot === 'accent') return <span className="swatch" style={{ background: (item as AccentItem).dark, width: size * 0.8, height: size * 0.8 }} />;
  return <span className="swatch text" style={{ height: size * 0.7 }}>{(item as TitleItem).text || 'По уровню'}</span>;
}

function ItemSheet({ item, onClose }: { item: ShopItem; onClose: () => void }) {
  const g = useGame();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const owned = g.owned.has(item.id);
  const on = g.equipped[item.slot] === item.id;
  const poor = !owned && !item.requires && g.coins < item.price;

  const act = async () => {
    setBusy(true);
    try {
      if (!owned) {
        const r = await buyItem(item.id);
        if (!r.ok) { toast(r.reason === 'poor' ? 'Не хватает монет' : r.reason === 'owned' ? 'Уже куплено' : 'Это нельзя купить'); return; }
        await equipItem(item.slot, item.id);
        toast(`Куплено и надето: ${item.name}`);
      } else {
        await equipItem(item.slot, on ? null : item.id);
        toast(on ? 'Снято' : `Надето: ${item.name}`);
      }
      onClose();
    } finally { setBusy(false); }
  };

  return (
    <Sheet title={item.name} onClose={onClose}>
      <div className="preview-stage" style={item.slot === 'banner' ? ({ background: (item as BannerItem).bg } as CSSProperties) : undefined}>
        {item.slot === 'banner'
          ? <Avatar avatarId={g.equipped.avatar} frameId={g.equipped.frame} name={g.name} size={72} />
          : item.slot === 'title'
            ? <div className="profile-title big">{(item as TitleItem).text || g.rank}</div>
            : <ItemPreview item={item} name={g.name} equipped={g.equipped} size={item.slot === 'accent' ? 72 : 96} />}
      </div>
      <p className="sub" style={{ margin: '12px 0' }}>{item.desc}{item.slot === 'avatar' && (item as AvatarItem).motion ? ' Анимированный: тапните по аватару в профиле.' : ''}</p>
      {item.requires && !owned && <p className="sub" style={{ marginBottom: 12 }}>Откроется само, когда вы получите достижение «{item.requires === 'dev' ? '???' : ACHIEVEMENTS.find((a) => a.id === item.requires)?.title}».</p>}
      {item.requires && !owned ? (
        <button className="btn block" disabled>Недоступно</button>
      ) : (
        <button className={'btn block' + (on ? '' : ' primary')} disabled={busy || poor} onClick={act}>
          {owned ? (on ? 'Снять' : 'Надеть') : poor ? `Не хватает ${fmtCoins(item.price - g.coins)} монет` : `Купить за ${fmtCoins(item.price)}`}
        </button>
      )}
      {!owned && !item.requires && <p className="sub" style={{ marginTop: 8, textAlign: 'center' }}>У вас {fmtCoins(g.coins)} монет</p>}
    </Sheet>
  );
}
