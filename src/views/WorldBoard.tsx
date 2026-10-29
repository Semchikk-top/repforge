import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { SEED_EXERCISES } from '../domain/seed';
import { formatNum } from '../lib';
import { periodFor } from '../social/leaderboard';
import { useFriends, useProfile } from '../social/hooks';
import {
  BoardError, boardConfigured, fetchBoard, getWorldState, joinWorld, leaveWorld, NICK_MAX, REPORT_LABELS, reportPlayer, submitWorld,
  WORLD_KINDS, type BoardEntry, type BoardPage, type ReportReason, type WorldKind, type WorldMetric
} from '../social/world';
import { PERIOD_LABELS } from '../social/leaderboard';
import { go } from '../state/router';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { StandingCard, plural, type StandingInfo } from './StandingCard';

type Mode = 'total' | 'cardio' | 'exercise';
const MODES: { id: Mode; label: string }[] = [{ id: 'total', label: 'Общая нагрузка' }, { id: 'cardio', label: 'Кардио' }, { id: 'exercise', label: 'По упражнению' }];
const TOTAL: { id: WorldMetric; label: string }[] = [{ id: 'volume', label: 'Тоннаж' }, { id: 'sets', label: 'Рабочие подходы' }, { id: 'workouts', label: 'Тренировки' }];
const EX: { id: WorldMetric; label: string }[] = [{ id: 'e1rm', label: '1ПМ' }, { id: 'exvolume', label: 'Объём' }, { id: 'exsets', label: 'Подходы' }];
const EXERCISES = SEED_EXERCISES.filter((e) => e.muscle !== 'cardio').map((e) => ({ key: e.id, name: e.name }));
const PAGE = 50;

const fmt = (metric: WorldMetric, v: number) =>
  metric === 'cardio' ? `${formatNum(v)} км` : metric === 'sets' || metric === 'workouts' || metric === 'exsets' ? formatNum(v) : `${formatNum(Math.round(v))} кг`;

const second = (metric: WorldMetric, sec: number) =>
  metric === 'cardio' ? `${sec} ${plural(sec, 'занятие', 'занятия', 'занятий')}`
  : metric === 'workouts' || metric === 'sets' || metric === 'volume' ? `${sec} ${plural(sec, 'рабочий подход', 'рабочих подхода', 'рабочих подходов')}`
  : metric === 'e1rm' || metric === 'exvolume' ? `${sec} ${plural(sec, 'подход', 'подхода', 'подходов')}` : '';

function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 2) return 'только что';
  if (m < 60) return `${m} мин назад`;
  if (m < 48 * 60) return `${Math.round(m / 60)} ч назад`;
  return `${Math.round(m / 1440)} дн. назад`;
}

/** Мировая таблица. Участие добровольное: пока человек не вступил, ничего не уходит наружу. */
export function WorldBoard() {
  const toast = useToast();
  const profile = useProfile();
  const friends = useFriends();
  const st = useLiveQuery(getWorldState, [], undefined);
  const [kind, setKind] = useState<WorldKind>('week');
  const [mode, setMode] = useState<Mode>('total');
  const [metric, setMetric] = useState<WorldMetric>('volume');
  const [exercise, setExercise] = useState(EXERCISES[0]?.key ?? '');
  const [page, setPage] = useState<BoardPage | null>(null);
  const [rows, setRows] = useState<BoardEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [nick, setNick] = useState('');
  const [agree, setAgree] = useState(false);
  const [working, setWorking] = useState(false);
  const [reporting, setReporting] = useState<BoardEntry | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const joined = !!st?.joined;
  const myPid = profile?.profileId ?? '';
  const friendIds = useMemo(() => new Set(friends.filter((f) => f.status === 'accepted').map((f) => f.profileId)), [friends]);
  const now = Date.now();

  const pickMode = (m: Mode) => { setMode(m); setMetric(m === 'total' ? 'volume' : m === 'cardio' ? 'cardio' : 'e1rm'); };
  const query = useMemo(() => ({
    kind, metric, exercise: mode === 'exercise' ? exercise : undefined,
    from: kind === 'all' ? undefined : periodFor(kind).from, me: joined ? myPid : undefined
  }), [kind, metric, mode, exercise, joined, myPid]);

  // первая страница: при смене периода, метрики, упражнения или по кнопке «Обновить»
  useEffect(() => {
    if (!boardConfigured() || !joined) return;
    let stale = false;
    setBusy(true); setError('');
    fetchBoard({ ...query, limit: PAGE, offset: 0 })
      .then((p) => { if (!stale) { setPage(p); setRows(p.entries); } })
      .catch((e: unknown) => { if (!stale) { setError(e instanceof Error ? e.message : 'Не удалось загрузить таблицу'); setPage(null); setRows([]); } })
      .finally(() => { if (!stale) setBusy(false); });
    return () => { stale = true; };
  }, [query, joined, tick]);

  const more = useCallback(async () => {
    setBusy(true);
    try {
      const p = await fetchBoard({ ...query, limit: PAGE, offset: rows.length });
      setRows((cur) => [...cur, ...p.entries.filter((e) => !cur.some((c) => c.pid === e.pid))]);
      setPage(p);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить'); } finally { setBusy(false); }
  }, [query, rows.length]);

  const place: StandingInfo | null = useMemo(() => {
    const me = page?.me;
    if (!me || !page) return null;
    const above = [...rows].reverse().find((r) => r.value > me.value && r.pid !== me.pid) ?? null;
    const below = rows.find((r) => r.value < me.value) ?? null;
    return {
      rank: me.rank, of: page.total, tied: rows.some((r) => r.pid !== me.pid && r.value === me.value),
      toNext: above ? Math.round((above.value - me.value) * 100) / 100 : null, nextName: above?.nick ?? null,
      lead: below ? Math.round((me.value - below.value) * 100) / 100 : null
    };
  }, [page, rows]);

  if (!boardConfigured()) {
    return (
      <div className="section" style={{ marginTop: 8 }}>
        <p className="sub">Мировой рейтинг в этой сборке не подключён: для него нужен общий сервис (папка <code>board/</code>) и его адрес при сборке: <code>VITE_BOARD_URL=https://board.example npm run build</code>. Рейтинг среди друзей работает без него.</p>
      </div>
    );
  }
  if (profile === undefined || st === undefined) return <p className="empty">Загрузка…</p>;
  if (!profile) {
    return (
      <div className="section" style={{ marginTop: 8 }}>
        <p className="room-note">Для мирового рейтинга нужен профиль: он даёт ключ, которым подписываются ваши итоги, чтобы никто не мог выдать себя за вас.</p>
        <button className="btn primary block" onClick={() => go('profile/friends')}>Создать профиль</button>
      </div>
    );
  }

  const fail = (e: unknown, fallback: string) => toast(e instanceof BoardError || e instanceof Error ? e.message : fallback);

  if (!joined) {
    return (
      <div className="section" style={{ marginTop: 8 }}>
        <p>Сравните свои итоги с людьми со всего мира. Это добровольно и отключается в любой момент.</p>
        {st.lastError && <p className="room-note">{st.lastError}</p>}
        <div className="field">
          <label htmlFor="wb-nick">Ник в рейтинге</label>
          <input id="wb-nick" className="input" maxLength={NICK_MAX} value={nick} onChange={(e) => setNick(e.target.value)} placeholder="Придумайте ник, не настоящее имя" autoComplete="off" />
          <span className="sub">Другие увидят ник и короткий код вроде #a1b2. Имя, которое вы показываете друзьям, сюда не попадает.</span>
        </div>
        <div className="world-sent">
          <b>Что уйдёт на сервис рейтинга:</b>
          <ul>
            <li>ник и открытый ключ профиля;</li>
            <li>итоги за неделю, месяц и всё время: тоннаж, подходы, тренировки, километры;</li>
            <li>1ПМ, объём и подходы по стартовым упражнениям (свои упражнения не уходят).</li>
          </ul>
          <b>Не уйдёт никогда:</b> сами тренировки и их даты, заметки, замеры тела, фото, маршруты, ассистент.
          <p className="sub" style={{ marginTop: 6 }}>Цифры считаются у вас и подписываются вашим ключом, но сервис не может проверить, что они правдивы: отсекается лишь невозможное. Выйдя из рейтинга, вы удаляете свой ник и все итоги с сервера.</p>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>Понимаю, что мой ник и итоги будут видны всем в мировой таблице</span>
        </label>
        <button className="btn primary block" disabled={working || !agree || nick.trim().length < 2} onClick={async () => {
          setWorking(true);
          try { await joinWorld(nick); toast('Вы в мировом рейтинге'); } catch (e) { fail(e, 'Не удалось вступить'); } finally { setWorking(false); }
        }}>{working ? 'Вступаю…' : 'Вступить в мировой рейтинг'}</button>
      </div>
    );
  }

  const metrics = mode === 'total' ? TOTAL : mode === 'exercise' ? EX : [];
  const period = page?.period;
  const mine = rows.some((r) => r.pid === myPid);
  const rest = page ? page.total - rows.length : 0;

  return (
    <div>
      <div className="chips wrap" role="group" aria-label="Период">
        {WORLD_KINDS.map((k) => <button key={k} className={'chip' + (kind === k ? ' on' : '')} aria-pressed={kind === k} onClick={() => setKind(k)}>{PERIOD_LABELS[k]}</button>)}
      </div>
      <div className="chips wrap" role="group" aria-label="Что сравниваем" style={{ marginTop: 6 }}>
        {MODES.map((m) => <button key={m.id} className={'chip' + (mode === m.id ? ' on' : '')} aria-pressed={mode === m.id} onClick={() => pickMode(m.id)}>{m.label}</button>)}
      </div>
      {metrics.length > 0 && (
        <div className="chips wrap" role="group" aria-label="Метрика" style={{ marginTop: 6 }}>
          {metrics.map((m) => <button key={m.id} className={'chip' + (metric === m.id ? ' on' : '')} aria-pressed={metric === m.id} onClick={() => setMetric(m.id)}>{m.label}</button>)}
        </div>
      )}
      {mode === 'exercise' && (
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="wb-ex">Упражнение</label>
          <select id="wb-ex" className="input" value={exercise} onChange={(e) => setExercise(e.target.value)}>
            {EXERCISES.map((e) => <option key={e.key} value={e.key}>{e.name}</option>)}
          </select>
        </div>
      )}

      {place && <div style={{ marginTop: 12 }}><StandingCard s={place} fmt={(v) => fmt(metric, v)} /></div>}
      {page && !page.me && !busy && <p className="sub" style={{ marginTop: 12 }}>Вас нет в этой таблице: за период нет данных по этой метрике{st.lastSubmitAt ? '' : ' или итоги ещё не отправлены'}.</p>}

      <div className="list rating" style={{ marginTop: 12 }} aria-busy={busy}>
        {error && <div className="room-note">{error} <button className="btn small" onClick={() => setTick((t) => t + 1)}>Повторить</button></div>}
        {!error && !busy && page && rows.length === 0 && <p className="empty">В этой таблице пока никого. Вы можете стать первым.</p>}
        {!error && busy && rows.length === 0 && <p className="empty">Загружаю…</p>}
        {rows.map((r) => {
          const isMe = r.pid === myPid;
          return (
            <div key={r.pid} className={'row rank-row' + (isMe ? ' me' : '')} style={{ flexWrap: 'wrap' }}>
              <div className={'rank-n' + (r.rank <= 3 ? ` medal m${r.rank}` : '')} aria-label={`Место ${r.rank}`}>{r.rank}</div>
              <div className="grow" onClick={() => !isMe && setOpen(open === r.pid ? null : r.pid)} style={{ cursor: isMe ? 'default' : 'pointer' }}>
                <div className="title">{r.nick}<span className="tag"> #{r.tag}</span>{isMe ? ' (вы)' : ''}{friendIds.has(r.pid) && <span className="badge-friend">друг</span>}</div>
                <div className="meta">{second(metric, r.sec)}{now - r.at > 3 * 86_400_000 ? ` · итоги ${ago(r.at, now)}` : ''}</div>
              </div>
              <div className="rank-v">{fmt(metric, r.value)}</div>
              {open === r.pid && !isMe && (
                <div style={{ width: '100%', marginTop: 8 }}>
                  <button className="btn small ghost" onClick={() => { setReporting(r); setOpen(null); }}>Пожаловаться</button>
                </div>
              )}
            </div>
          );
        })}
        {page?.me && !mine && (
          <>
            <div className="rank-gap" aria-hidden="true">⋮</div>
            <div className="row rank-row me">
              <div className="rank-n" aria-label={`Место ${page.me.rank}`}>{page.me.rank}</div>
              <div className="grow"><div className="title">{st.nick}<span className="tag"> #{myPid.slice(2, 6)}</span> (вы)</div><div className="meta">{second(metric, page.me.sec)}</div></div>
              <div className="rank-v">{fmt(metric, page.me.value)}</div>
            </div>
          </>
        )}
      </div>
      {rest > 0 && <button className="btn block ghost" style={{ marginTop: 10 }} disabled={busy} onClick={() => void more()}>{busy ? 'Загружаю…' : `Показать ещё (${Math.min(PAGE, rest)} из ${formatNum(rest)})`}</button>}

      <p className="sub">
        {period ? (kind === 'all' ? 'За всё время' : `Период: ${period.from.slice(8)}.${period.from.slice(5, 7)} – ${period.to.slice(8)}.${period.to.slice(5, 7)}`) : ''}
        {page ? ` · участников в таблице: ${formatNum(page.total)}` : ''}. Равные результаты делят место. Подпись доказывает, чьи это итоги, но не то, что они правдивы: сервис отсекает только невозможные цифры. Считаются рабочие подходы без разминок; кардио отдельно.
      </p>

      <div className="section">
        <h2>Моё участие</h2>
        <p className="sub">Ник: <b>{st.nick}</b> #{myPid.slice(2, 6)}. {st.lastSubmitAt ? `Итоги отправлены ${ago(st.lastSubmitAt, now)}.` : 'Итоги ещё не отправлялись.'} Приложение обновляет их само, пока открыто.</p>
        {st.lastError && <p className="room-note">{st.lastError}</p>}
        <button className="btn block" disabled={working} onClick={async () => {
          setWorking(true);
          try { await submitWorld(true); setTick((t) => t + 1); toast('Итоги отправлены'); } catch (e) { fail(e, 'Не удалось отправить итоги'); } finally { setWorking(false); }
        }}>Отправить мои итоги сейчас</button>
        {renaming ? (
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="wb-rename">Новый ник</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input id="wb-rename" className="input" maxLength={NICK_MAX} defaultValue={st.nick} onChange={(e) => setNick(e.target.value)} />
              <button className="btn" disabled={working || nick.trim().length < 2} onClick={async () => {
                setWorking(true);
                try { await joinWorld(nick); setRenaming(false); setTick((t) => t + 1); toast('Ник изменён'); } catch (e) { fail(e, 'Не удалось сменить ник'); } finally { setWorking(false); }
              }}>Сохранить</button>
            </div>
          </div>
        ) : <button className="btn block ghost" style={{ marginTop: 8 }} onClick={() => { setNick(st.nick); setRenaming(true); }}>Сменить ник</button>}
        <button className="btn block ghost" style={{ marginTop: 8, color: 'var(--danger, #d33)' }} disabled={working} onClick={async () => {
          if (!confirm('Выйти из мирового рейтинга? Ваш ник и все итоги будут удалены с сервиса. Локальные данные не пострадают.')) return;
          setWorking(true);
          try { await leaveWorld(); setPage(null); setRows([]); toast('Вы вышли, данные удалены с сервиса'); } catch (e) { fail(e, 'Не удалось выйти: данные на сервисе остались, попробуйте позже'); } finally { setWorking(false); }
        }}>Выйти и удалить мои данные с сервиса</button>
      </div>

      {reporting && (
        <Sheet title={`Пожаловаться на ${reporting.nick}`} onClose={() => setReporting(null)}>
          <p className="sub">Модератор посмотрит жалобу. Когда на участника пожалуются несколько давних участников, он скрывается из таблиц до проверки.</p>
          {(Object.keys(REPORT_LABELS) as ReportReason[]).map((reason) => (
            <button key={reason} className="btn block" style={{ marginBottom: 8 }} onClick={async () => {
              try { await reportPlayer(reporting.pid, reason); toast('Жалоба отправлена'); } catch (e) { fail(e, 'Не удалось отправить жалобу'); }
              setReporting(null);
            }}>{REPORT_LABELS[reason]}</button>
          ))}
        </Sheet>
      )}
    </div>
  );
}
