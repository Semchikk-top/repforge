import { useEffect, useState } from 'react';
import { platform } from '../../platform';
import type { ExactAlarmState } from '../../platform/types';
import { useSettings } from '../../state/settings';
import { Toggle } from '../../ui/Toggle';
import { useToast } from '../../ui/Toast';
import { NumInput } from './NumInput';

export function TrainingTab() {
  const { settings, update } = useSettings();
  const toast = useToast();

  const askNotifications = async () => {
    if (platform.notifications.permission() === 'unsupported') { toast('Уведомления не поддерживаются'); return; }
    const p = await platform.notifications.request();
    toast(p === 'granted' ? 'Уведомления включены' : platform.info.native ? 'Уведомления запрещены в настройках телефона' : 'Уведомления запрещены в браузере');
  };

  // Android 12+: без точных будильников система вправе задержать сигнал таймера в фоне на минуты
  const [exact, setExact] = useState<ExactAlarmState>('unsupported');
  useEffect(() => {
    const check = () => void platform.notifications.exactAlarm().then(setExact);
    check();
    return platform.lifecycle.onResume(check);
  }, []);
  const notifState = platform.notifications.permission() === 'unsupported' ? 'denied' : platform.notifications.permission();

  return (
    <div className="section" style={{ marginTop: 0 }}>
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
      <div className="row"><div className="grow">Не гасить экран во время тренировки</div><Toggle label="Не гасить экран" checked={settings.keepAwake} onChange={(v) => update({ keepAwake: v })} /></div>
      <div className="row"><div className="grow">Звук окончания отдыха</div><Toggle label="Звук" checked={settings.sound} onChange={(v) => update({ sound: v })} /></div>
      <div className="row"><div className="grow">Вибрация</div><Toggle label="Вибрация" checked={settings.vibrate} onChange={(v) => update({ vibrate: v })} /></div>
      <div className="row"><div className="grow">Напоминать убрать инвентарь<div className="sub">После последнего рабочего подхода упражнения. Отдых начнётся после галочки. Для упражнений со своим весом и кардио не показывается.</div></div><Toggle label="Напоминать убрать инвентарь" checked={settings.cleanupEnabled} onChange={(v) => update({ cleanupEnabled: v })} /></div>
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
  );
}
