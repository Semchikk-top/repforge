import { useRef } from 'react';
import { useToast } from '../../ui/Toast';
import { unlockManual } from '../../game/store';
import { go } from '../../state/router';
import { useGame } from '../../game/hooks';
import { diagnosticsUnlocked } from '../../sync/diagnostics';
import { openExternal } from '../../ui/openExternal';
import { LEGAL } from '../../legal/config';

export function AboutTab() {
  const toast = useToast();
  const devTools = diagnosticsUnlocked(useGame().unlocked);
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

  return (
    <>
      <div className="section" style={{ marginTop: 0 }}>
        <h2>О приложении</h2>
        <button className="btn block" onClick={() => void openLink(LEGAL.githubUrl)}>Десктопная версия и локальный сервер</button>
        <button className="btn block" style={{ marginTop: 8 }} onClick={() => void openLink(LEGAL.supportUrl)}>Поддержать разработчика</button>
        <button className="btn block" style={{ marginTop: 8 }} onClick={() => go('privacy')}>Политика конфиденциальности</button>
        <p className="sub" style={{ marginTop: 8 }}>
          Основные функции работают без сервера и без регистрации. Сервер на ПК нужен только для синхронизации, ассистента и озвучки Fish Speech.
          Поддержка добровольная: приложение полностью работает и без неё.
        </p>
      </div>

      {devTools && <button className="btn block" style={{ marginTop: 12 }} onClick={() => go('diagnostics')}>Диагностика</button>}

      <p className="sub" style={{ textAlign: 'center', marginTop: 24 }} onClick={onVersionTap}>Версия {__APP_VERSION__.replace(/-.*$/, '')}</p>
    </>
  );
}
