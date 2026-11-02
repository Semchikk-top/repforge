import { useRef, useState, type CSSProperties } from 'react';
import { platform } from '../platform';
import { Glyph } from './glyphs';
import { DEFAULTS, ITEM_BY_ID, type AvatarItem, type FrameItem } from './catalog';

interface Props {
  avatarId?: string;
  frameId?: string;
  name?: string;
  size?: number;
  /** Тап запускает реакцию (подпрыгивание и искры). */
  interactive?: boolean;
}

export function Avatar({ avatarId = DEFAULTS.avatar, frameId = DEFAULTS.frame, name = '', size = 40, interactive }: Props) {
  const av = (ITEM_BY_ID.get(avatarId) as AvatarItem | undefined) ?? (ITEM_BY_ID.get(DEFAULTS.avatar) as AvatarItem);
  const fr = (ITEM_BY_ID.get(frameId) as FrameItem | undefined) ?? (ITEM_BY_ID.get(DEFAULTS.frame) as FrameItem);
  const [poke, setPoke] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const pad = fr.css === 'fr-none' ? 0 : Math.max(2, Math.round(size * 0.07));
  const inner = size - pad * 2;
  const letter = (name.trim()[0] ?? '?').toUpperCase();

  const onTap = () => {
    setPoke((n) => n + 1);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPoke(0), 700);
    platform.haptics.vibrate(12);
  };

  const body = (
    <span className={'av-face' + (av.motion ? ' m-' + av.motion : '')} style={{ width: inner, height: inner, background: `radial-gradient(circle at 30% 25%, ${av.c1}, ${av.c2})`, color: av.fg } as CSSProperties}>
      {av.letter ? <span className="av-letter" style={{ fontSize: inner * 0.5 }}>{letter}</span> : <Glyph name={av.glyph} size={Math.round(inner * 0.56)} />}
    </span>
  );

  const Tag = interactive ? 'button' : 'span';
  return (
    <Tag
      className={'av ' + fr.css + (poke ? ' poke' : '')}
      style={{ width: size, height: size, padding: pad } as CSSProperties}
      {...(interactive ? { type: 'button' as const, onClick: onTap, 'aria-label': 'Аватар' } : {})}
    >
      {fr.css === 'fr-rainbow' && <span className="av-ring"><i className="av-spinner" /></span>}
      {body}
      {poke > 0 && <span key={poke} className="av-sparks" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <i key={i} style={{ '--a': `${i * 60}deg` } as CSSProperties} />)}</span>}
    </Tag>
  );
}
