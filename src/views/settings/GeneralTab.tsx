import { useSettings } from '../../state/settings';

export function GeneralTab() {
  const { settings, update } = useSettings();
  return (
    <>
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
    </>
  );
}
