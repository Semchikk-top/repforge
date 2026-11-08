import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { dropIndex } from '../domain/reorder';
import { platform } from '../platform';
import './reorder.css';

// Перетаскивание блоков упражнений за ручку. Без библиотек.
// Каждая карточка — <section class="ex-block" data-block="N">, где N — номер блока (суперсет = один блок).
// Пока палец ведёт блок, мы двигаем его через transform напрямую в DOM, а не через состояние React:
// так экран не перерисовывается на каждое движение. Куда блок встанет, показывает линия data-drop.

interface Placed { first: HTMLElement; last: HTMLElement; mid: number }
interface Session {
  block: number;
  pointerId: number;
  handle: HTMLElement;
  startY: number;
  startScroll: number;
  clientY: number;
  target: number;
  blocks: Placed[];
  raf: number;
}

const EDGE = 90; // px от края экрана, где начинается автопрокрутка

function collect(): Placed[] {
  const byBlock = new Map<number, HTMLElement[]>();
  document.querySelectorAll<HTMLElement>('section.ex-block[data-block]').forEach((el) => {
    const n = Number(el.dataset.block);
    byBlock.set(n, [...(byBlock.get(n) ?? []), el]);
  });
  return [...byBlock.entries()].sort((a, b) => a[0] - b[0]).map(([, els]) => {
    const first = els[0], last = els[els.length - 1];
    const top = first.getBoundingClientRect().top + window.scrollY;
    const bottom = last.getBoundingClientRect().bottom + window.scrollY;
    return { first, last, mid: (top + bottom) / 2 };
  });
}

function sectionsOf(block: number): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`section.ex-block[data-block="${block}"]`)];
}

function clearMarks() {
  document.querySelectorAll('[data-drop]').forEach((el) => el.removeAttribute('data-drop'));
}

export function useBlockDrag(onDrop: (from: number, to: number) => void) {
  const session = useRef<Session | null>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const cleanupRef = useRef<(() => void) | null>(null);

  const update = useCallback(() => {
    const s = session.current;
    if (!s) return;
    const dy = (s.clientY - s.startY) + (window.scrollY - s.startScroll);
    sectionsOf(s.block).forEach((el) => { el.style.transform = `translateY(${dy}px)`; });
    // Ориентир — центр перетаскиваемого блока: так предсказуемо и для высоких карточек, и для суперсетов.
    const t = dropIndex(s.blocks.map((b) => b.mid), s.block, s.blocks[s.block].mid + dy);
    if (t !== s.target) {
      s.target = t;
      clearMarks();
      if (t !== s.block) {
        const others = s.blocks.filter((_, i) => i !== s.block);
        if (t < others.length) others[t].first.setAttribute('data-drop', 'before');
        else others[others.length - 1].last.setAttribute('data-drop', 'after');
      }
      platform.haptics.vibrate(8);
    }
  }, []);

  const finish = useCallback((commit: boolean) => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    cancelAnimationFrame(s.raf);
    cleanupRef.current?.();
    cleanupRef.current = null;
    try { s.handle.releasePointerCapture(s.pointerId); } catch { /* уже отпущен */ }
    document.querySelectorAll<HTMLElement>('section.ex-block').forEach((el) => { el.style.transform = ''; el.removeAttribute('data-dragging'); });
    clearMarks();
    document.body.classList.remove('reordering');
    if (commit && s.target !== s.block) dropRef.current(s.block, s.target);
  }, []);

  const begin = useCallback((e: ReactPointerEvent<HTMLElement>, block: number) => {
    if (session.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const blocks = collect();
    if (blocks.length < 2 || !blocks[block]) return;
    const handle = e.currentTarget;
    try { handle.setPointerCapture(e.pointerId); } catch { /* без захвата работаем через window */ }
    const s: Session = { block, pointerId: e.pointerId, handle, startY: e.clientY, startScroll: window.scrollY, clientY: e.clientY, target: block, blocks, raf: 0 };
    session.current = s;
    sectionsOf(block).forEach((el) => el.setAttribute('data-dragging', '1'));
    document.body.classList.add('reordering');
    platform.haptics.vibrate(15);

    const move = (ev: PointerEvent) => { if (ev.pointerId === s.pointerId) { s.clientY = ev.clientY; update(); } };
    const up = (ev: PointerEvent) => { if (ev.pointerId === s.pointerId) finish(true); };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === s.pointerId) finish(false); };
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') finish(false); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
    };

    // автопрокрутка у края экрана: длинную тренировку иначе не перетащить
    const tick = () => {
      if (session.current !== s) return;
      const h = window.innerHeight;
      const v = s.clientY < EDGE ? -Math.ceil((EDGE - s.clientY) / 6) : s.clientY > h - EDGE ? Math.ceil((s.clientY - (h - EDGE)) / 6) : 0;
      if (v) { window.scrollBy(0, v); update(); }
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  }, [finish, update]);

  useEffect(() => () => finish(false), [finish]);

  /** Свойства для кнопки-ручки блока с номером block. */
  const handleProps = (block: number) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => begin(e, block),
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => e.preventDefault()
  });

  return { handleProps };
}
