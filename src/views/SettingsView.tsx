import { useEffect, useRef, useState } from 'react';
import { platform } from '../platform';
import { BackupSection } from './BackupSection';
import { openBackupText } from '../db/autoBackup';
import type { ExactAlarmState } from '../platform/types';
import { exportAll, importAll } from '../db/repo';
import { useSettings } from '../state/settings';
import { Toggle } from '../ui/Toggle';
import { useToast } from '../ui/Toast';
import { toDateStr } from '../lib';
import { SyncSection } from './SyncSection';
import { ExportSheet } from './ExportSheet';
import { ImportWorkoutsSheet } from './ImportWorkoutsSheet';
import { unlockManual } from '../game/store';
import { go } from '../state/router';
import { IconBack } from '../ui/Icons';
import { ConflictsCard } from './ConflictsCard';
import { BACKEND_LABEL, getAssistantStatus, resolveBackend, type AssistantStatus, type Backend } from '../assistant/api';
import { AssistantConnect } from './AssistantConnect';
import { useSyncStatus } from '../sync/useSync';
import { useGame } from '../game/hooks';
import { diagnosticsUnlocked } from '../sync/diagnostics';
import { openExternal } from '../ui/openExternal';
import { LEGAL } from '../legal/config';

function backendStatus(b: Backend, paired: boolean, st: AssistantStatus | null): string {
  if (!paired) return 'Ассистент работает через сервер на ПК: сначала подключи устройство ниже.';
  if (!st) return 'Проверяю доступность…';
  if (b === 'cloud') return st.cloud.configured ? `Облако готово, модель ${st.cloud.model}.` : 'Облако не настроено: нажми «Настроить подключение» и введи API-ключ.';
  if (b === 'local') return st.local.reachable ? `Ollama работает${st.local.model ? `, модель ${st.local.model}` : ', но моделей нет: выполни ollama pull'}.` : 'Ollama не отвечает на ПК. Запусти её или проверь адрес в настройках подключения.';
  if (!st.agent.configured) return 'Агент не подключён: нажми «Настроить подключение» и укажи его адрес.';
  return st.agent.reachable ? `Агент отвечает${st.agent.model ? `, модель ${st.agent.model}` : ''}.` : 'Агент не отвечает: проверь, что он запущен и адрес верный.';
}

// Числовое поле настроек, которое можно полностью очистить. Обычный контролируемый
// input с валидацией в onChange отвергает промежуточные состояния: пока текст не
// разбирается в число (например, пустая строка после Backspace), значение настроек
// не меняется, и контролируемый input мгновенно возвращает старое число — набрать
// «0» невозможно. Поэтому пока фокус в поле, показываем черновик ввода как есть и
// обновляем настройку только когда текст разбирается; пустое поле считаем нулём
// (для целей недели 0 = «выключено»). На выходе из поля неразобранный черновик
// откатывается к значению из настроек.
function NumInput({ id, inputMode, value, parse, onChange }: {
  id: string;
  inputMode: 'numeric' | 'decimal';
  value: number;
  parse: (text: string) => number | null;
  onChange: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);
  return (
    <input id={id} className="input" inputMode={inputMode} value={text}
      onChange={(e) => {
        const t = e.target.value;
        setDraft(t);
        const n = parse(t);
        if (n !== null) onChange(n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

export function SettingsView() {
  const { settings, update } = useSettings();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const sync = useSyncStatus();
  const devTools = diagnosticsUnlocked(useGame().unlocked);
  const [astatus, setAstatus] = useState<AssistantStatus | null>(null);
  const [connect, setConnect] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const refreshStatus = () => { if (sync.configured && !sync.unauthorized) void getAssistantStatus().then(setAstatus); };
  useEffect(refreshStatus, [sync.configured, sync.unauthorized]); // eslint-disable-line react-hooks/exhaustive-deps
  const backend = resolveBackend(settings);

  const doExport = async () => {
    const blob = new Blob([await exportAll()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trenirovki-${toDateStr(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const doImport = async (file: File) => {
    try {
      // зашифрованную копию читаем по паролю (или ключом приложения, если она сделана здесь же)
      const text = await openBackupText(await file.text(), () => prompt('Пароль от этой копии'));
      const r = await importAll(text);
      toast(`Импортировано: тренировок ${r.workouts}, упражнений ${r.exercises}, шаблонов ${r.templates}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось прочитать файл');
    }
  };

  const askNotifications = async () => {
    if (platform.notifications.permission() === 'unsupported') { toast('Уведомления не поддерживаются'); return; }
    const p = await platform.notifications.request();
    toast(p === 'granted' ? 'Уведомления включены' : platform.info.native ? 'Уведомления запрещены в настройках телефона' : 'Уведомления запрещены в браузере');
  };

  const openLink = async (url: string) => { if (!(await openExternal(url))) toast('Не удалось открыть ссылку'); };

  const taps = useRef({ n: 0, t: 0 });
  const onVersionTap = () => {
    const now = Date.now();
    taps.current = { n: now - taps.current.t < 1500 ? taps.current.n + 1 : 1, t: now };
    if (taps.current.n >= 7) {
      taps.current.n = 0;
      void unlockManual('dev').then((a) => { if (a) toast(`Достижение: ${a.title} (+${a.reward} монет)`); });
    }
  };

  // Android 12+: без точных будильников система вправе задержать сигнал таймера в фоне на минуты
  const [exact, setExact] = useState<ExactAlarmState>('unsupported');
  useEffect(() => {
    const check = () => void platform.notifications.exactAlarm().then(setExact);
    check();
    return platform.lifecycle.onResume(check);
  }, []);
  // Хранилище страницы: если система не обещает беречь данные при нехватке места, честно об этом говорим
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => { void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null)); }, []);
  const notifState = platform.notifications.permission() === 'unsupported' ? 'denied' : platform.notifications.permission();

  return (
    <div>
      <div className="head-row">
        <button className="icon-btn" onClick={() => go('profile')} aria-label="К профилю"><IconBack /></button>
        <h1 style={{ margin: 0 }}>Настройки</h1>
      </div>

      <div className="section" style={{ marginTop: 0 }}>
        <h2>Аналитика</h2>
        <div className="seg" data-i={settings.analyticsMode === 'deep' ? 1 : 0} role="group" aria-label="Режим аналитики">
          <button className={settings.analyticsMode === 'basic' ? 'on' : ''} onClick={() => update({ analyticsMode: 'basic' })}>Основная</button>
          <button className={settings.analyticsMode === 'deep' ? 'on' : ''} onClick={() => update({ analyticsMode: 'deep' })}>Глубокая</button>
        </div>
        <p className="sub" style={{ marginTop: 8 }}>Глубокая добавляет прогресс по упражнениям, мышечные группы, нагрузку и поиск плато.</p>
      </div>

      <div className="section">
        <h2>Внешний вид</h2>
        <div className="seg three" data-i={(['dark', 'light', 'auto'] as const).indexOf(settings.theme)} role="group" aria-label="Тема">
          {([['dark', 'Тёмная'], ['light', 'Светлая'], ['auto', 'Как в системе']] as const).map(([k, label]) => (
            <button key={k} className={settings.theme === k ? 'on' : ''} onClick={() => update({ theme: k })}>{label}</button>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Ассистент</h2>
        <div className="seg three" data-i={(['cloud', 'local', 'agent'] as Backend[]).indexOf(backend)} role="group" aria-label="Модель ассистента">
          {(['cloud', 'local', 'agent'] as Backend[]).map((b) => (
            <button key={b} className={backend === b ? 'on' : ''} onClick={() => update({ assistantBackend: b })}>{BACKEND_LABEL[b]}</button>
          ))}
        </div>
        <p className="sub" style={{ marginTop: 8 }}>{backendStatus(backend, !!sync.configured, astatus)}</p>
        <p className="sub" style={{ marginTop: 6 }}>{backend === 'cloud' ? 'В облачном режиме нужные записи из дневника уходят провайдеру модели. Локальные режимы ничего не отправляют наружу.' : 'Локальный режим ничего не отправляет наружу, всё считается на твоём ПК.'}</p>
        <button className="btn block" style={{ marginTop: 12 }} disabled={!sync.configured || sync.unauthorized} onClick={() => setConnect(true)}>Настроить подключение</button>
        {connect && <AssistantConnect initial={backend} onClose={() => setConnect(false)} onChanged={refreshStatus} />}
      </div>

      <div className="section">
        <h2>Тренировка</h2>
        <div className="field">
          <label htmlFor="rest">Отдых по умолчанию, секунды</label>
          <NumInput id="rest" inputMode="numeric" value={settings.defaultRestSec}
            parse={(t) => { const s = t.trim(); if (s === '') return null; const n = parseInt(s, 10); return Number.isFinite(n) && n > 0 && n < 1800 ? n : null; }}
            onChange={(n) => update({ defaultRestSec: n })} />
        </div>
        <div className="field">
          <label htmlFor="step">Шаг веса, кг</label>
          <select id="step" className="input" value={settings.weightStep} onChange={(e) => update({ weightStep: parseFloat(e.target.value) })}>
            {[0.5, 1, 1.25, 2, 2.5, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="goal-w">Цель недели: тренировок (0 — выключить)</label>
          <NumInput id="goal-w" inputMode="numeric" value={settings.weeklyGoalWorkouts}
            parse={(t) => { const s = t.trim(); if (s === '') return 0; const n = parseInt(s, 10); return Number.isFinite(n) && n >= 0 && n <= 14 ? n : null; }}
            onChange={(n) => update({ weeklyGoalWorkouts: n })} />
        </div>
        <div className="field">
          <label htmlFor="goal-km">Цель недели: километров бега и ходьбы (0 — выключить)</label>
          <NumInput id="goal-km" inputMode="decimal" value={settings.weeklyGoalKm}
            parse={(t) => { const s = t.trim().replace(',', '.'); if (s === '') return 0; const n = parseFloat(s); return Number.isFinite(n) && n >= 0 && n <= 500 ? n : null; }}
            onChange={(n) => update({ weeklyGoalKm: n })} />
        </div>
        <div className="field">
          <label htmlFor="zone">Скрывать начало и конец маршрута</label>
          <select id="zone" className="input" value={settings.privacyZoneM} onChange={(e) => update({ privacyZoneM: parseInt(e.target.value, 10) })}>
            {[[0, 'не скрывать'], [100, '100 м'], [200, '200 м'], [500, '500 м']].map(([n, l]) => <option key={n} value={n}>{l}</option>)}
          </select>
          <span className="sub">Касается маршрута на экране и файла GPX: чтобы не показывать, где ты живёшь.</span>
        </div>
        <div className="row"><div className="grow">Голосовые подсказки на каждом километре</div><Toggle label="Голосовые подсказки" checked={settings.voiceCues} onChange={(v) => update({ voiceCues: v })} /></div>
        <div className="row"><div className="grow">Не гасить экран во время тренировки</div><Toggle label="Не гасить экран" checked={settings.keepAwake} onChange={(v) => update({ keepAwake: v })} /></div>
        <div className="row"><div className="grow">Звук окончания отдыха</div><Toggle label="Звук" checked={settings.sound} onChange={(v) => update({ sound: v })} /></div>
        <div className="row"><div className="grow">Вибрация</div><Toggle label="Вибрация" checked={settings.vibrate} onChange={(v) => update({ vibrate: v })} /></div>
        <div className="row">
          <div className="grow">
            <div>Уведомление, когда экран выключен</div>
            <div className="meta">{notifState === 'granted' ? 'Разрешено' : notifState === 'denied' ? 'Запрещено в браузере' : 'Нужно разрешение'}</div>
          </div>
          <button className="btn small" disabled={notifState !== 'default'} onClick={askNotifications}>Разрешить</button>
        </div>
        {exact === 'denied' && (
          <div className="row">
            <div className="grow">
              <div>Точные уведомления</div>
              <div className="meta">Выключены: сигнал об окончании отдыха в фоне может опаздывать на минуты. Откроются настройки Android.</div>
            </div>
            <button className="btn small" onClick={() => void platform.notifications.requestExactAlarm().then(setExact)}>Разрешить</button>
          </div>
        )}
        <div className="row">
          <div className="grow">Напоминать о тренировке по плану
            <div className="meta">В выбранное время, если на этот день запланирована тренировка. {platform.notifications.background ? 'Приходит и при закрытом приложении.' : 'Работает, пока приложение открыто или свёрнуто.'}</div>
          </div>
          <Toggle label="Напоминание" checked={settings.reminderEnabled} onChange={(v) => update({ reminderEnabled: v })} />
        </div>
        {settings.reminderEnabled && (
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="rem-time">Время напоминания</label>
            <input id="rem-time" className="input" type="time" value={settings.reminderTime} onChange={(e) => { if (/^\d{2}:\d{2}$/.test(e.target.value)) update({ reminderTime: e.target.value }); }} />
            {notifState !== 'granted' && <span className="sub">Без разрешения на уведомления напоминание появится только внутри приложения.</span>}
          </div>
        )}

        <div className="row" style={{ marginTop: 8 }}>
          <div className="grow">Утренний чек-ин самочувствия
            <div className="meta">Обычное уведомление. {platform.notifications.background ? 'Если чек-ин уже заполнен, повторно не приходит.' : 'Работает только в приложении для телефона.'}</div>
          </div>
          <Toggle label="Утренний чек-ин" checked={settings.checkinMorningEnabled} onChange={(v) => update({ checkinMorningEnabled: v })} />
        </div>
        {settings.checkinMorningEnabled && (
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="ci-morning-time">Время утреннего чек-ина</label>
            <input id="ci-morning-time" className="input" type="time" value={settings.checkinMorningTime} onChange={(e) => { if (/^\d{2}:\d{2}$/.test(e.target.value)) update({ checkinMorningTime: e.target.value }); }} />
          </div>
        )}
        <div className="row">
          <div className="grow">Недельный разбор
            <div className="meta">Раз в неделю карточка на календаре: что выросло, где застой, что поменять. Считается на этом устройстве, данные никуда не отправляются.</div>
          </div>
          <Toggle label="Недельный разбор" checked={settings.weeklyReviewEnabled} onChange={(v) => update({ weeklyReviewEnabled: v })} />
        </div>
        <div className="row">
          <div className="grow">Вечерний чек-ин самочувствия
            <div className="meta">Итог дня и сравнение с утром.</div>
          </div>
          <Toggle label="Вечерний чек-ин" checked={settings.checkinEveningEnabled} onChange={(v) => update({ checkinEveningEnabled: v })} />
        </div>
        {settings.checkinEveningEnabled && (
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="ci-evening-time">Время вечернего чек-ина</label>
            <input id="ci-evening-time" className="input" type="time" value={settings.checkinEveningTime} onChange={(e) => { if (/^\d{2}:\d{2}$/.test(e.target.value)) update({ checkinEveningTime: e.target.value }); }} />
          </div>
        )}
      </div>

      <div className="section">
        <h2>Данные</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" style={{ flex: 1 }} onClick={doExport}>Экспорт в файл</button>
          <button className="btn" style={{ flex: 1 }} onClick={() => fileRef.current?.click()}>Импорт из файла</button>
        </div>
        <button className="btn block" style={{ marginTop: 8 }} onClick={() => setExporting(true)}>Экспорт за период…</button>
        <button className="btn block" style={{ marginTop: 8 }} onClick={() => setImportingCsv(true)}>Импорт из Hevy или Strong…</button>
        <button className="btn block" style={{ marginTop: 8 }} onClick={() => go('start')}>Подобрать стартовую программу</button>
        {exporting && <ExportSheet onClose={() => setExporting(false)} />}
        {importingCsv && <ImportWorkoutsSheet onClose={() => setImportingCsv(false)} />}
        <BackupSection />
        {persisted === false && <p className="sub" style={{ marginTop: 8 }}>Система не гарантирует сохранность данных приложения при нехватке места на телефоне. Делай экспорт или подключи синхронизацию с ПК.</p>}
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ''; }} />
      </div>

      <ConflictsCard />

      <SyncSection />

      <div className="section">
        <h2>О приложении</h2>
        <button className="btn block" onClick={() => void openLink(LEGAL.githubUrl)}>Десктопная версия и локальный сервер</button>
        <button className="btn block" style={{ marginTop: 8 }} onClick={() => void openLink(LEGAL.supportUrl)}>Поддержать разработчика</button>
        <button className="btn block" style={{ marginTop: 8 }} onClick={() => go('privacy')}>Политика конфиденциальности</button>
        <p className="sub" style={{ marginTop: 8 }}>
          Основные функции работают без сервера и без регистрации. Сервер на ПК нужен только для синхронизации и ассистента.
          Поддержка добровольная: приложение полностью работает и без неё.
        </p>
      </div>

      {devTools && <button className="btn block" style={{ marginTop: 12 }} onClick={() => go('diagnostics')}>Диагностика</button>}

      <p className="sub" style={{ textAlign: 'center', marginTop: 24 }} onClick={onVersionTap}>Версия {__APP_VERSION__.replace(/-.*$/, '')}</p>
    </div>
  );
}
