import type { ChatMsg } from './api';

/** Диалог с ассистентом в виде Markdown: для заметок, тренера или архива. Ошибки и остановленные ответы помечаются. */
export function chatToMarkdown(messages: ChatMsg[], when: Date = new Date()): string {
  const out = [`# Диалог с ассистентом, ${when.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`, ''];
  for (const m of messages) {
    if (m.error && !m.content) continue;
    out.push(m.role === 'user' ? '## Вы' : '## Ассистент', '', m.content.trim() || '(пусто)', '');
    for (const p of m.proposals ?? []) {
      if (p.title) out.push(`> Предложена тренировка: ${p.title} (${p.date})`, '');
    }
    if (m.stopped) out.push('> Ответ остановлен.', '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
