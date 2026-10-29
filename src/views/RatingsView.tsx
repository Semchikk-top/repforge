import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { Exercise, Workout } from '../domain/types';
import { formatNum } from '../lib';
import { hasWarmupMarks, buildStats, PERIOD_KINDS, PERIOD_LABELS, periodFor, type PeriodKind } from '../social/leaderboard';
import { buildCardioTable, buildTable, exerciseChoices, standing, type ExerciseMetric, type Participant, type Row, type TotalMetric } from '../social/ranking';
import { useFriends, usePeerSnapshots, useProfile } from '../social/hooks';
import type { LeaderboardSnapshot } from '../social/snapshot';
import { go } from '../state/router';
import { IconBack } from '../ui/Icons';
import { FriendSheet } from './FriendSheet';
import { StandingCard, plural } from './StandingCard';
import { WorldBoard } from './WorldBoard';

type Mode = 'total' | 'exercise' | 'cardio';

const MODES: { id: Mode; label: string }[] = [{ id: 'total', label: 'Общая нагрузка' }, { id: 'exercise', label: 'По упражнению' }, { id: 'cardio', label: 'Кардио' }];
const TOTAL_METRICS: { id: TotalMetric; label: string }[] = [{ id: 'volume', label: 'Тоннаж' }, { id: 'sets', label: 'Рабочие подходы' }, { id: 'workouts', label: 'Тренировки' }];
const EX_METRICS: { id: ExerciseMetric; label: string }[] = [{ id: 'e1rm', label: '1ПМ' }, { id: 'volume', label: 'Объём' }, { id: 'sets', label: 'Подходы' }];

const fmtValue = (mode: Mode, metric: string, v: number) =>
  mode === 'cardio' ? `${formatNum(v)} км` : metric === 'sets' || metric === 'workouts' ? `${formatNum(v)}` : `${formatNum(Math.round(v))} кг`;

/** Рейтинги: друзья (обмен подписанными итогами без сервера) и мир (добровольный общий сервис). */
export function RatingsView() {
  const [scope, setScope] = useState<'friends' | 'world'>(() => (sessionStorage.getItem('ratings-scope') === 'world' ? 'world' : 'friends'));
  const pick = (v: 'friends' | 'world') => { setScope(v); sessionStorage.setItem('ratings-scope', v); };
  return (
    <div>
      <div className="head-row">
        <button className="icon-btn" onClick={() => go('stats')} aria-label="К аналитике"><IconBack /></button>
        <h1 style={{ margin: 0 }}>Рейтинги</h1>
      </div>
      <div className="seg" data-i={scope === 'world' ? 1 : 0} role="group" aria-label="Среди кого" style={{ marginBottom: 12 }}>
        <button className={scope === 'friends' ? 'on' : ''} aria-pressed={scope === 'friends'} onClick={() => pick('friends')}>Друзья</button>
        <button className={scope === 'world' ? 'on' : ''} aria-pressed={scope === 'world'} onClick={() => pick('world')}>Весь мир</button>
      </div>
      {scope === 'friends' ? <FriendsBoard /> : <WorldBoard />}
    </div>
  );
}

/** Рейтинг среди друзей. Снимки подписаны, чужие данные не выдаются за свежие; килограммы и километры не смешиваются. */
function FriendsBoard() {
  const workouts = useLiveQuery(() => db.workouts.toArray(), [], [] as Workout[]);
  const exercises = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[]);
  const profile = useProfile();
  const friends = useFriends();
  const peerRows = usePeerSnapshots();
  const [kind, setKind] = useState<PeriodKind>('week');
  const [mode, setMode] = useState<Mode>('total');
  const [totalMetric, setTotalMetric] = useState<TotalMetric>('volume');
  const [exMetric, setExMetric] = useState<ExerciseMetric>('e1rm');
  const [exKey, setExKey] = useState<string>('');
  const [adding, setAdding] = useState(false);

  const now = Date.now();
  const period = useMemo(() => periodFor(kind), [kind]);

  const people: Participant[] = useMemo(() => {
    const stats = buildStats(workouts, exercises, period);
    const mineSnap: LeaderboardSnapshot = {
      v: 1, profileId: profile?.profileId ?? 'me', displayName: profile?.displayName ?? 'Вы', publicKey: profile?.publicKey ?? '', period,
      generatedAt: now, nonce: '', sig: '', ...stats
    };
    const out: Participant[] = [{ profileId: mineSnap.profileId, name: profile?.displayName ?? 'Вы', isMe: true, snapshot: mineSnap }];
    for (const f of friends) {
      if (f.status !== 'accepted' || !f.permissions.leaderboard) continue;
      const own = peerRows.filter((r) => r.profileId === f.profileId).map((r) => r.snapshot);
      const exact = own.find((s) => s.period.from === period.from && s.period.to === period.to);
      const latest = [...own].sort((a, b) => b.generatedAt - a.generatedAt)[0] ?? null;
      out.push({ profileId: f.profileId, name: f.displayName, isMe: false, snapshot: exact ?? latest });
    }
    return out;
  }, [workouts, exercises, period, profile, friends, peerRows, now]);

  const choices = useMemo(() => exerciseChoices(people, period), [people, period]);
  const activeKey = exKey && choices.some((c) => c.key === exKey) ? exKey : choices[0]?.key ?? '';

  const rows: Row[] = mode === 'cardio' ? buildCardioTable(people, period, now)
    : mode === 'total' ? buildTable(people, period, totalMetric, now)
    : activeKey ? buildTable(people, period, exMetric, now, activeKey) : [];
  const metricId = mode === 'total' ? totalMetric : exMetric;

  const withFriends = people.length > 1;
  const marks = useMemo(() => hasWarmupMarks(workouts), [workouts]);

  const place = useMemo(() => standing(rows), [rows]);

  return (
    <div>
      <div className="chips wrap" role="group" aria-label="Период">
        {PERIOD_KINDS.map((k) => <button key={k} className={'chip' + (kind === k ? ' on' : '')} aria-pressed={kind === k} onClick={() => setKind(k)}>{PERIOD_LABELS[k]}</button>)}
      </div>
      <div className="chips wrap" role="group" aria-label="Что сравниваем" style={{ marginTop: 6 }}>
        {MODES.map((m) => <button key={m.id} className={'chip' + (mode === m.id ? ' on' : '')} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>)}
      </div>
      {mode !== 'cardio' && (
        <div className="chips wrap" role="group" aria-label="Метрика" style={{ marginTop: 6 }}>
          {(mode === 'total' ? TOTAL_METRICS : EX_METRICS).map((m) => {
            const on = (mode === 'total' ? totalMetric : exMetric) === m.id;
            return <button key={m.id} className={'chip' + (on ? ' on' : '')} aria-pressed={on} onClick={() => (mode === 'total' ? setTotalMetric(m.id as TotalMetric) : setExMetric(m.id as ExerciseMetric))}>{m.label}</button>;
          })}
        </div>
      )}
      {mode === 'exercise' && (
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="rt-ex">Упражнение</label>
          <select id="rt-ex" className="input" value={activeKey} onChange={(e) => setExKey(e.target.value)} disabled={choices.length === 0}>
            {choices.length === 0 && <option value="">нет данных за период</option>}
            {choices.map((c) => <option key={c.key} value={c.key}>{c.name}{c.people > 1 ? ` · ${c.people} чел.` : ''}</option>)}
          </select>
        </div>
      )}

      {place && withFriends && <div style={{ marginTop: 12 }}><StandingCard s={place} fmt={(v) => fmtValue(mode, metricId, v)} /></div>}

      <div className="list rating" style={{ marginTop: 12 }}>
        {rows.length === 0 && <p className="empty">Пока нет данных для таблицы.</p>}
        {rows.map((r) => (
          <div key={r.profileId + mode} className={'row rank-row' + (r.isMe ? ' me' : '') + (r.rank === null ? ' off' : '')}>
            <div className={'rank-n' + (r.rank && r.rank <= 3 ? ` medal m${r.rank}` : '')} aria-label={r.rank ? `Место ${r.rank}` : 'Вне таблицы'}>{r.rank ?? '–'}</div>
            <div className="grow">
              <div className="title">{r.name}{r.isMe ? ' (вы)' : ''}</div>
              <div className="meta">{r.note ?? (r.rank ? (mode === 'cardio' ? `${r.sets} ${plural(r.sets, 'тренировка', 'тренировки', 'тренировок')}` : `${r.sets} ${plural(r.sets, 'рабочий подход', 'рабочих подхода', 'рабочих подходов')}`) : '')}{r.note && r.rank ? ` · ${r.sets}` : ''}</div>
            </div>
            {r.value !== null && <div className="rank-v">{fmtValue(mode, metricId, r.value)}</div>}
          </div>
        ))}
      </div>

      <p className="sub">Период: {period.from === '1970-01-01' ? 'всё время' : `${period.from.slice(8)}.${period.from.slice(5, 7)} – ${period.to.slice(8)}.${period.to.slice(5, 7)}`}. Рейтинг дружеский: подпись доказывает, чьи это итоги, но не то, что они правдивы.</p>
      {mode === 'exercise' && <p className="sub">Упражнения сравниваются по общему ключу: стартовые напрямую, свои только при совпадении названия, группы мышц и оборудования.</p>}
      {mode === 'total' && <p className="sub">Тоннаж: сумма вес × повторы по выполненным рабочим подходам. Кардио считается отдельно.</p>}
      {!marks && <p className="sub">Разминочных подходов в данных нет: если вы их выполняли без отметки, они считаются рабочими. В подходе есть переключатель «Разминка».</p>}

      <div className="section">
        {!profile && <p className="room-note">Профиля нет: можно смотреть свои итоги, но поделиться ими и добавить друзей нельзя. Создайте профиль на вкладке «Друзья».</p>}
        {!withFriends && profile && <p className="sub">Друзей в рейтинге пока нет. Добавьте друга по коду или файлом.</p>}
        <button className="btn block" disabled={!profile} onClick={() => setAdding(true)}>Добавить друга или обновить итоги</button>
        <button className="btn block ghost" style={{ marginTop: 8 }} onClick={() => go('profile/friends')}>Профиль и друзья</button>
      </div>
      {adding && <FriendSheet onClose={() => setAdding(false)} />}
    </div>
  );
}
