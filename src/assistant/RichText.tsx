import type { ReactNode } from 'react';

// Лёгкий разбор ответа модели: абзацы, списки, **жирный** и `код`. Без dangerouslySetInnerHTML.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;

export function RichText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);

  blocks.forEach((block, bi) => {
    const lines = block.split('\n').filter((l) => l.trim());
    let i = 0;
    while (i < lines.length) {
      const kind = BULLET.test(lines[i]) ? 'ul' : NUMBER.test(lines[i]) ? 'ol' : 'p';
      const re = kind === 'ul' ? BULLET : NUMBER;
      const group: string[] = [];
      while (i < lines.length && (kind === 'p' ? !BULLET.test(lines[i]) && !NUMBER.test(lines[i]) : re.test(lines[i]))) {
        group.push(kind === 'p' ? lines[i] : lines[i].replace(re, ''));
        i++;
      }
      const key = `${bi}-${nodes.length}`;
      if (kind === 'p') nodes.push(<p key={key}>{group.flatMap((l, k) => (k ? [<br key={`b${k}`} />, ...inline(l)] : inline(l)))}</p>);
      else {
        const items = group.map((l, k) => <li key={k}>{inline(l)}</li>);
        nodes.push(kind === 'ul' ? <ul key={key}>{items}</ul> : <ol key={key}>{items}</ol>);
      }
    }
  });
  return <>{nodes}</>;
}
