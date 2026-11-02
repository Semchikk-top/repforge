import { useEffect } from 'react';
import { autoBackupSupported, declineRestoreOffer, findRestoreOffer, restoreAutoBackup, runAutoBackup } from '../db/autoBackup';
import { platform } from '../platform';
import { useToast } from '../ui/Toast';
import { useSettings } from './settings';

/**
 * Нативная оболочка: при запуске предлагает восстановить данные, если их нет, а автокопия есть; затем раз в сутки
 * (через 20 секунд после запуска и при уходе приложения в фон) делает новую копию. В браузере ничего не делает.
 */
export function useAutoBackup(): void {
  const { ready } = useSettings();
  const toast = useToast();

  useEffect(() => {
    if (!ready || !autoBackupSupported()) return;
    let alive = true;
    const backup = () => { void runAutoBackup().catch(() => { /* копия необязательна: повторим в следующий раз */ }); };

    void (async () => {
      const offer = await findRestoreOffer().catch(() => null);
      if (!alive || !offer) return;
      const when = new Date(offer.at).toLocaleDateString('ru-RU');
      if (confirm(`На этом устройстве нет данных, но найдена автокопия от ${when}: тренировок ${offer.workouts}. Восстановить?`)) {
        try {
          const r = await restoreAutoBackup(offer.name);
          toast(`Восстановлено: тренировок ${r.workouts}, упражнений ${r.exercises}`);
        } catch (e) { toast(e instanceof Error ? e.message : 'Не удалось восстановить данные'); }
      } else {
        await declineRestoreOffer(offer.name);
      }
    })();

    const t = setTimeout(backup, 20_000);
    const off = platform.lifecycle.onPause(backup);
    return () => { alive = false; clearTimeout(t); off(); };
  }, [ready, toast]);
}
