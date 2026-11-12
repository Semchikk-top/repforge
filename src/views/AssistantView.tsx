import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { db } from '../db/db';
import { resolveBackend, streamChat, type ChatMsg, type ProposalState, type StreamEvent } from '../assistant/api';
import { createWorkoutFromProposal } from '../assistant/proposal';
import { RichText } from '../assistant/RichText';
import { formatDateLong, formatNum, todayStr, uid } from '../lib';
import { back, go } from '../state/router';
import { chatToMarkdown } from '../assistant/transcript';
import { download } from '../db/exporter';
import { Sheet } from '../ui/Sheet';
import { useSettings } from '../state/settings';
import { syncNow } from '../sync/sync';
import { IconBack, IconSend, IconSpark, IconStop } from '../ui/Icons';
import { useToast } from '../ui/Toast';

const KV_KEY = 'assistant.chat';
const SUGGESTIONS = [
  'Проанализируй мою неделю',
  'Составь план на 4 недели на основе моей истории',
  'Разбери мою последнюю пробежку',
  'Как у меня дела за последний месяц?',
  'Составь тренировку на завтра',
  'Есть ли у меня плато?',
  'Что стоит улучшить в моей программе?'
];
const QUICK = SUGGESTIONS.slice(0, 3);

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function AssistantView() {
  const { settings, ready } = useSettings();
  const toast = useToast();
  const backend = resolveBackend(settings);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toolLabel, setToolLabel] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // история чата хранится на устройстве и не синхронизируется
  useEffect(() => {
    db.kv.get(KV_KEY).then((row) => {
      setMessages(((row?.value as ChatMsg[]) ?? []).map((m) => ({ ...m, stopped: false })));
      setLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (loaded && !busy) void db.kv.put({ key: KV_KEY, value: messages });
  }, [messages, busy, loaded]);

  // автопрокрутка, пока пользователь сам не отлистал вверх
  useLayoutEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, busy, toolLabel]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // поле ввода растёт вместе с текстом
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  }, [input]);

  const patch = useCallback((id: string, fn: (m: ChatMsg) => ChatMsg) => {
    setMessages((all) => all.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const apply = useCallback((id: string, ev: StreamEvent) => {
    if (ev.type === 'delta') { setToolLabel(null); patch(id, (m) => ({ ...m, content: m.content + ev.text })); }
    else if (ev.type === 'tool') setToolLabel(ev.label + '…');
    else if (ev.type === 'proposal') patch(id, (m) => ({ ...m, proposals: [...(m.proposals ?? []), { ...ev.proposal, id: uid() }] }));
    else if (ev.type === 'notice') patch(id, (m) => ({ ...m, notices: [...(m.notices ?? []), ev.text] }));
    else if (ev.type === 'error') patch(id, (m) => ({ ...m, error: ev.message }));
  }, [patch]);

  const send = async (text: string) => {
    text = text.trim();
    if (!text || busy) return;
    const user: ChatMsg = { id: uid(), role: 'user', content: text };
    const bot: ChatMsg = { id: uid(), role: 'assistant', content: '' };
    const history = [...messages.filter((m) => !m.error || m.content), user].map(({ role, content }) => ({ role, content }));
    setMessages([...messages, user, bot]);
    setInput('');
    setBusy(true);
    stick.current = true;
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      // ассистент читает данные на сервере: сначала отправляем туда свежие правки (но не ждём дольше 4 секунд)
      await Promise.race([syncNow(), wait(4000)]);
      for await (const ev of streamChat(backend, history, todayStr(), ctl.signal)) apply(bot.id, ev);
      // поток закончился, а ответа нет — не оставляем пустой пузырь без объяснения
      patch(bot.id, (m) => (m.content.trim() || m.notices?.length || m.error || m.proposals?.length
        ? m
        : { ...m, notices: ['Ассистент не прислал ответ. Попробуй ещё раз или проверь подключение в настройках.'] }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') patch(bot.id, (m) => ({ ...m, stopped: true }));
      else patch(bot.id, (m) => ({ ...m, error: e instanceof Error ? e.message : 'Что-то пошло не так' }));
    } finally {
      setBusy(false);
      setToolLabel(null);
      abortRef.current = null;
    }
  };

  const addProposal = async (msgId: string, p: ProposalState) => {
    try {
      const workoutId = await createWorkoutFromProposal(p);
      patch(msgId, (m) => ({ ...m, proposals: m.proposals?.map((x) => (x.id === p.id ? { ...x, workoutId } : x)) }));
      toast('Тренировка добавлена в календарь');
    } catch {
      toast('Не удалось добавить тренировку');
    }
  };

  const newChat = () => {
    if (messages.length && !confirm('Начать новый чат? Текущая переписка будет удалена с этого устройства.')) return;
    abortRef.current?.abort();
    setMessages([]);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const touch = matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); void send(input); }
  };

  // вопрос из другого экрана (например, из подсказки по упражнению): подставляем в поле, отправляет человек
  useEffect(() => {
    let alive = true;
    void db.kv.get('assistant.prefill').then(async (row) => {
      if (!alive || typeof row?.value !== 'string') return;
      await db.kv.delete('assistant.prefill');
      setInput(row.value.slice(0, 2000));
      setTimeout(() => taRef.current?.focus(), 50);
    });
    return () => { alive = false; };
  }, []);

  const last = messages[messages.length - 1];

  return (
    <div className="chat">
      <header className="chat-head">
        <button className="icon-btn" style={{ marginLeft: -8 }} onClick={() => (window.history.length > 1 ? back() : go('calendar'))} aria-label="Назад"><IconBack /></button>
        <div className="grow">
          <div className="chat-title">Ассистент</div>
          <div className="sub">{backend === 'cloud' ? 'Облачная модель' : backend === 'agent' ? 'Локальный агент' : 'Ollama'}</div>
        </div>
        <button className="btn small ghost" onClick={() => setSaving(true)} disabled={!messages.length}>Сохранить</button>
        <button className="btn small ghost" onClick={newChat} disabled={!messages.length}>Новый чат</button>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {loaded && messages.length === 0 && ready && (
          <div className="chat-empty">
            <div className="chat-empty-icon"><IconSpark size={28} /></div>
            <h2>Спроси про свои тренировки</h2>
            <p className="sub">Я вижу историю и рекорды, могу составить тренировку, а ты решишь, добавлять ли её в календарь.</p>
            <div className="chat-suggest">
              {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}
            </div>
            {backend === 'cloud' && <p className="sub" style={{ marginTop: 16 }}>В облачном режиме нужные записи из дневника отправляются провайдеру модели вместе с вопросом.</p>}
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={'msg ' + (m.role === 'user' ? 'user' : 'bot')}>
            {m.role === 'user' ? <p>{m.content}</p> : (
              <>
                {m.content && <div className="msg-text"><RichText text={m.content} /></div>}
                {busy && m === last && !m.content && !m.error && (
                  <div className="typing" aria-label="Ассистент печатает">{toolLabel ? <span className="tool-chip">{toolLabel}</span> : <><i /><i /><i /></>}</div>
                )}
                {busy && m === last && m.content && toolLabel && <div className="typing"><span className="tool-chip">{toolLabel}</span></div>}
                {m.notices?.map((n, i) => <div key={i} className="notice">{n}</div>)}
                {m.proposals?.map((p) => (
                  <div key={p.id} className="proposal">
                    <div className="proposal-head">
                      <div className="ex-name" style={{ fontSize: 22 }}>{p.title}</div>
                      <div className="sub cap">{formatDateLong(p.date)}</div>
                    </div>
                    <ul className="proposal-list">
                      {p.exercises.map((e, i) => (
                        <li key={i}><span>{e.name}</span><span className="sub">{e.sets}×{e.reps}{e.weight ? ` · ${formatNum(e.weight)} кг` : ''}</span></li>
                      ))}
                    </ul>
                    {p.workoutId
                      ? <button className="btn block" onClick={() => go(`workout/${p.workoutId}`)}>Открыть тренировку</button>
                      : <button className="btn primary block" onClick={() => void addProposal(m.id, p)}>Добавить в календарь</button>}
                  </div>
                ))}
                {m.stopped && <div className="sub">Остановлено</div>}
                {m.error && (
                  <div className="msg-error" role="alert">
                    <div>{m.error}</div>
                    {/не настроен|недоступна|подключ/i.test(m.error) && <button className="btn small" style={{ marginTop: 8 }} onClick={() => go('settings/server')}>Открыть настройки</button>}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {!busy && messages.length > 0 && (
        <div className="chips quick-chips" aria-label="Быстрые вопросы">
          {QUICK.map((q) => <button key={q} className="chip" onClick={() => void send(q)}>{q}</button>)}
        </div>
      )}
      <div className="chat-input">
        <textarea
          ref={taRef}
          className="input"
          rows={1}
          value={input}
          placeholder="Спроси что-нибудь"
          aria-label="Сообщение ассистенту"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
        />
        {busy
          ? <button className="send stop" onClick={() => abortRef.current?.abort()} aria-label="Остановить"><IconStop size={20} /></button>
          : <button className="send" onClick={() => void send(input)} disabled={!input.trim()} aria-label="Отправить"><IconSend size={22} /></button>}
      </div>
      {saving && (
        <Sheet title="Сохранить диалог" onClose={() => setSaving(false)}>
          <p className="sub">Весь текущий диалог в формате Markdown: рекомендации и планы останутся у тебя в заметках.</p>
          <button className="btn primary block" onClick={() => { download(`assistant-${todayStr()}.md`, chatToMarkdown(messages), 'text/markdown;charset=utf-8'); setSaving(false); toast('Диалог сохранён'); }}>Скачать файл (.md)</button>
          <button className="btn block" style={{ marginTop: 8 }} onClick={async () => { try { await navigator.clipboard.writeText(chatToMarkdown(messages)); toast('Скопировано'); setSaving(false); } catch { toast('Не удалось скопировать: сохрани файлом'); } }}>Скопировать текст</button>
        </Sheet>
      )}
    </div>
  );
}
