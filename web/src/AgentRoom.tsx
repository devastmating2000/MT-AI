import { Activity, CandlestickChart, FlaskConical, Newspaper, Scale, Send, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentId, AgentInfo, AgentMessage } from '../../shared/types';
import { hhmm } from './format';

const ICONS: Record<AgentId, LucideIcon> = {
  market: Activity, technical: CandlestickChart, news: Newspaper, strategist: FlaskConical, event: Zap,
  coordinator: Scale, risk: ShieldCheck, execution: Send,
};

interface Props {
  agents: AgentInfo[];
  messages: AgentMessage[];
  symbol: string;
}

export function AgentRoom({ agents, messages, symbol }: Props) {
  const [onlySymbol, setOnlySymbol] = useState(false);
  const names = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.name])) as Record<string, string>, [agents]);
  const shown = useMemo(() => (onlySymbol ? messages.filter((m) => m.symbol === symbol) : messages), [messages, onlySymbol, symbol]);

  // Follow the conversation unless the reader has scrolled up to look at something.
  const feed = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = feed.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  return (
    <section className="room" aria-label="Sala dos agentes">
      <header className="pane-head">
        <h2>Sala dos agentes</h2>
        <div className="seg" role="group" aria-label="Filtrar conversa">
          <button type="button" aria-pressed={!onlySymbol} onClick={() => setOnlySymbol(false)}>Tudo</button>
          <button type="button" aria-pressed={onlySymbol} onClick={() => setOnlySymbol(true)}>{symbol}</button>
        </div>
      </header>

      <ul className="roster">
        {agents.map((a) => {
          const Icon = ICONS[a.id];
          return (
            <li key={a.id} className={a.status === 'working' ? 'is-working' : ''} title={a.role}>
              <Icon size={15} strokeWidth={1.75} aria-hidden />
              <span className="roster-name">{a.name}</span>
              <span className="roster-state">{a.status === 'working' ? 'a trabalhar' : `${a.messages} msg`}</span>
            </li>
          );
        })}
      </ul>

      <ol
        className="feed"
        ref={feed}
        tabIndex={0}
        aria-label="Conversa entre agentes"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {shown.length === 0 && <li className="empty">Ainda sem mensagens{onlySymbol ? ` sobre ${symbol}` : ''}.</li>}
        {shown.map((m) => {
          const Icon = ICONS[m.from];
          return (
            <li key={m.id} className={`msg msg-${m.kind}`}>
              <Icon size={15} strokeWidth={1.75} aria-hidden className="msg-icon" />
              <div>
                <p className="msg-head">
                  <span className="msg-from">{names[m.from] ?? m.from}</span>
                  {m.to !== 'all' && <span className="msg-to"> para {names[m.to] ?? m.to}</span>}
                  <time>{hhmm(m.time)}</time>
                </p>
                <p className="msg-text">{m.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
