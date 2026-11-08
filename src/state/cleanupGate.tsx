import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { confirmGate, type CleanupGate } from './cleanupCore';
import { useRestTimer } from './timer';

// Гейт уборки инвентаря. Живёт внутри RestTimerProvider: после галочки он запускает обычный таймер отдыха.
// Состояние только в памяти: после перезагрузки плашка не возвращается (это напоминание, а не измеримый таймер).

interface Ctx {
  gate: CleanupGate | null;
  /** Открыть плашку вместо отдыха; идущий отдых прерывается, чтобы плашка и таймер не показывались вместе. */
  open: (gate: CleanupGate) => void;
  /** Галочка: закрыть плашку и запустить отложенный отдых. */
  confirm: () => void;
  /** Закрыть молча, отдых не запускается (следующий подход, завершение тренировки, отмена галочки). */
  dismiss: () => void;
}

const CleanupContext = createContext<Ctx>({ gate: null, open: () => {}, confirm: () => {}, dismiss: () => {} });

export function CleanupGateProvider({ children }: { children: ReactNode }) {
  const timer = useRestTimer();
  const [gate, setGate] = useState<CleanupGate | null>(null);
  const { start, cancel } = timer;

  const open = useCallback((g: CleanupGate) => { cancel(); setGate(g); }, [cancel]);
  const dismiss = useCallback(() => setGate(null), []);
  const confirm = useCallback(() => {
    const r = confirmGate(gate);
    setGate(r.gate);
    if (r.startRestSec !== null) start(r.startRestSec);
  }, [gate, start]);

  const value = useMemo(() => ({ gate, open, confirm, dismiss }), [gate, open, confirm, dismiss]);
  return <CleanupContext.Provider value={value}>{children}</CleanupContext.Provider>;
}

export const useCleanupGate = () => useContext(CleanupContext);
