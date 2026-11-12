import { go, replace, useRoute } from '../../state/router';
import { IconBack } from '../../ui/Icons';
import { AboutTab } from './AboutTab';
import { DataTab } from './DataTab';
import { GeneralTab } from './GeneralTab';
import { ServerTab } from './ServerTab';
import { SETTINGS_TABS, parseTab, type SettingsTabId } from './tabs';
import { TrainingTab } from './TrainingTab';
import { VoiceTab } from './VoiceTab';

const BODY: Record<SettingsTabId, () => JSX.Element> = {
  general: GeneralTab, training: TrainingTab, voice: VoiceTab, data: DataTab, server: ServerTab, about: AboutTab
};

export function SettingsView() {
  const segs = useRoute();
  const tab = parseTab(segs[1]);
  const Body = BODY[tab];
  return (
    <div>
      <div className="head-row">
        <button className="icon-btn" onClick={() => go('profile')} aria-label="К профилю"><IconBack /></button>
        <h1 style={{ margin: 0 }}>Настройки</h1>
      </div>

      {/* replace, а не go: «назад» ведёт в профиль, а не листает вкладки */}
      <div className="settings-tabs" role="tablist" aria-label="Разделы настроек">
        {SETTINGS_TABS.map((t) => (
          <button key={t.id} role="tab" id={`stab-${t.id}`} aria-selected={tab === t.id} aria-controls="settings-panel"
            className={'chip' + (tab === t.id ? ' on' : '')} onClick={() => replace(`settings/${t.id}`)}>{t.label}</button>
        ))}
      </div>

      <div id="settings-panel" role="tabpanel" aria-labelledby={`stab-${tab}`}><Body /></div>
    </div>
  );
}
