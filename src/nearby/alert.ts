// Сигнал «Позвать»: вибрация и звук. Звук разрешён браузером только после касания, поэтому
// unlockAudio() вызывается из обработчика кнопки «Создать комнату»/«Присоединиться».

let ctx: AudioContext | null = null;

export function unlockAudio(): void {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = ctx ?? new AC();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch { /* звук недоступен */ }
}

export function playCallSound(): void {
  const c = ctx;
  if (!c) return;
  const now = c.currentTime;
  // две пары коротких сигналов: отличается от писка таймера отдыха
  [0, 0.18, 0.5, 0.68].forEach((offset, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'square';
    osc.frequency.value = i % 2 === 0 ? 660 : 990;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.15);
    osc.connect(gain).connect(c.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.17);
  });
}

export function vibrateCall(): void {
  if ('vibrate' in navigator) navigator.vibrate([300, 150, 300, 150, 500]);
}
