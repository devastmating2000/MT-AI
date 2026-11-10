import { LogOut, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import type { AppState } from '../../shared/types';
import { AgentRoom } from './AgentRoom';
import { API_BASE, signOut, useSession } from './auth';
import { Login } from './Login';
import { num, price, sideLabel, signed, tone } from './format';
import { Equity, History, News, Positions, Risk, Strategies } from './Panels';
import { PriceChart } from './PriceChart';
import { useDesk, type DeskApi } from './useDesk';

const TABS = [
  { id: 'positions', label: 'Posições' },
  { id: 'history', label: 'Histórico' },
  { id: 'strategies', label: 'Estratégias' },
  { id: 'equity', label: 'Capital' },
  { id: 'news', label: 'Notícias' },
  { id: 'risk', label: 'Risco' },
] as const;
type Tab = (typeof TABS)[number]['id'];

function TopBar({ state, desk, email }: { state: AppState; desk: DeskApi; email?: string }) {
  const { account } = state;
  const venue = state.mode === 'paper'
    ? 'Simulador, dados sintéticos'
    : state.mode === 'live' ? (state.brokerConnected ? 'Cotações reais, execução simulada' : 'Cotações reais indisponíveis')
    : state.brokerConnected ? 'MetaTrader 5 ligado' : 'MetaTrader 5 desligado';
  return (
    <header className="top">
      <div className="brand">
        <span className="wordmark">MT-AI</span>
        <span className={state.mode !== 'paper' && !state.brokerConnected ? 'venue warn' : 'venue'}>{venue}</span>
      </div>
      <dl className="figures">
        <div><dt>Capital</dt><dd>{num(account.equity)} <small>{account.currency}</small></dd></div>
        <div><dt>Hoje</dt><dd className={tone(account.dayPnl)}>{signed(account.dayPnl)}</dd></div>
        <div><dt>Posições</dt><dd>{state.positions.length} de {state.risk.maxOpenPositions}</dd></div>
        <div><dt>Decisão</dt><dd className="plain">{state.llm.enabled ? state.llm.model : 'Regras, sem modelo'}</dd></div>
      </dl>
      <button
        type="button"
        className={state.tradingEnabled ? 'btn btn-stop' : 'btn btn-primary'}
        onClick={() => desk.setTrading(!state.tradingEnabled)}
      >
        {state.tradingEnabled ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />}
        {state.tradingEnabled ? 'Pausar negociação' : 'Retomar negociação'}
      </button>
      {email && (
        <button type="button" className="btn" title={email} onClick={() => signOut()}>
          <LogOut size={15} aria-hidden />
          Sair
        </button>
      )}
    </header>
  );
}

function Watchlist({ state, symbol, onSelect }: { state: AppState; symbol: string; onSelect: (s: string) => void }) {
  return (
    <nav className="watch" aria-label="Símbolos">
      <h2 className="pane-head">Mercados</h2>
      <ul>
        {state.symbols.map((spec) => {
          const tick = state.ticks[spec.symbol];
          const view = state.consensus[spec.symbol];
          const position = state.positions.find((p) => p.symbol === spec.symbol);
          return (
            <li key={spec.symbol}>
              <button type="button" aria-current={spec.symbol === symbol} onClick={() => onSelect(spec.symbol)}>
                <span className="watch-symbol">{spec.symbol}</span>
                <span className="watch-price">{tick ? price(tick.bid, spec) : '—'}</span>
                <span className="watch-label">{spec.label}</span>
                <span className="watch-view">
                  {position
                    ? <span className={tone(position.pnl)}>{sideLabel(position.direction)} {signed(position.pnl)}</span>
                    : view?.direction ? `${sideLabel(view.direction)} ${num(view.score)}` : 'Sem sinal'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function App() {
  const session = useSession();
  const signedIn = session.status === 'signedIn' || session.status === 'open';
  const desk = useDesk(signedIn);
  const { state } = desk;
  const [symbol, setSymbol] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('positions');

  if (session.status === 'checking') return <main className="boot"><p>A verificar a sessão…</p></main>;
  if (session.status === 'unreachable') {
    return (
      <main className="boot">
        <div>
          <p className="strong">Sem ligação ao servidor de agentes.</p>
          <p>
            Destino: {API_BASE || location.origin}. Este painel é só a interface; o servidor de agentes tem de estar a
            correr nesse endereço. Se estiver noutro sítio, defina VITE_API_URL e volte a publicar.
          </p>
        </div>
      </main>
    );
  }
  if (session.status === 'signedOut') return <Login />;
  if (!state) return <main className="boot"><p>{desk.online ? 'A carregar a mesa…' : 'A ligar ao servidor de agentes…'}</p></main>;
  const current = state.symbols.find((s) => s.symbol === symbol) ?? state.symbols[0];
  const view = state.consensus[current.symbol];
  const tick = state.ticks[current.symbol];

  return (
    <div className="shell">
      <TopBar state={state} desk={desk} email={session.status === 'signedIn' ? session.email : undefined} />
      {!desk.online && <p className="banner" role="alert">Ligação ao servidor perdida. A tentar de novo…</p>}
      {!state.tradingEnabled && <p className="banner" role="status">Negociação em pausa. Os agentes continuam a analisar, mas não enviam ordens.</p>}
      <Watchlist state={state} symbol={current.symbol} onSelect={setSymbol} />

      <main className="stage">
        <header className="stage-head">
          <div>
            <h1>{current.symbol} <span>{current.label}, velas de 15 min</span></h1>
            <p>{view ? `Última leitura do coordenador: ${view.outcome.toLowerCase()}.` : 'O coordenador ainda não avaliou este símbolo.'}</p>
          </div>
          {tick && (
            <dl className="quote">
              <div><dt>Venda</dt><dd>{price(tick.bid, current)}</dd></div>
              <div><dt>Compra</dt><dd>{price(tick.ask, current)}</dd></div>
            </dl>
          )}
        </header>
        <PriceChart key={current.symbol} spec={current} positions={state.positions.filter((p) => p.symbol === current.symbol)} subscribeBars={desk.subscribeBars} />

        <div className="tabs" role="tablist" aria-label="Detalhes da mesa">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="tabpanel" onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'positions' && state.positions.length > 0 && <span className="count">{state.positions.length}</span>}
            </button>
          ))}
        </div>
        <section className="panel" role="tabpanel" id="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'positions' && <Positions state={state} desk={desk} />}
          {tab === 'history' && <History state={state} />}
          {tab === 'strategies' && <Strategies state={state} symbol={current.symbol} />}
          {tab === 'equity' && <Equity points={state.equityCurve} currency={state.account.currency} />}
          {tab === 'news' && <News state={state} />}
          {tab === 'risk' && <Risk state={state} desk={desk} />}
        </section>
      </main>

      <AgentRoom agents={state.agents} messages={desk.messages} symbol={current.symbol} />
    </div>
  );
}
