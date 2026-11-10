import { useEffect, useMemo, useRef, useState } from 'react';
import { STRATEGY_LABELS, type AppState, type EquityPoint, type RiskSettings, type SymbolSpec } from '../../shared/types';
import { dayTime, hhmm, num, pct, price, sideLabel, signed, tone } from './format';
import type { DeskApi } from './useDesk';

const specOf = (state: AppState, symbol: string): SymbolSpec | undefined => state.symbols.find((s) => s.symbol === symbol);
const REASON = { tp: 'Alvo', sl: 'Stop', manual: 'Manual', broker: 'Corretor' } as const;

export function Positions({ state, desk }: { state: AppState; desk: DeskApi }) {
  if (!state.positions.length) return <p className="empty">Sem posições abertas. Os agentes abrem uma quando houver consenso e o risco aprovar.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Símbolo</th><th>Direção</th><th className="n">Lotes</th><th className="n">Entrada</th><th className="n">Stop</th><th className="n">Alvo</th><th className="n">Resultado</th><th>Estratégias</th><th><span className="sr">Ações</span></th></tr>
        </thead>
        <tbody>
          {state.positions.map((p) => {
            const spec = specOf(state, p.symbol);
            return (
              <tr key={p.id}>
                <td className="strong">{p.symbol}</td>
                <td>{sideLabel(p.direction)}</td>
                <td className="n">{num(p.lots)}</td>
                <td className="n">{price(p.entryPrice, spec)}</td>
                <td className="n">{price(p.stopLoss, spec)}</td>
                <td className="n">{price(p.takeProfit, spec)}</td>
                <td className={`n ${tone(p.pnl)}`}>{signed(p.pnl)}</td>
                <td>{p.strategies.map((s) => STRATEGY_LABELS[s]).join(', ') || 'Manual'}</td>
                <td className="n"><button type="button" className="btn btn-quiet" onClick={() => desk.closePosition(p.id)}>Fechar</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function History({ state }: { state: AppState }) {
  if (!state.trades.length) return <p className="empty">Ainda não fechou nenhuma operação nesta sessão.</p>;
  const wins = state.trades.filter((t) => t.pnl > 0).length;
  const total = state.trades.reduce((a, t) => a + t.pnl, 0);
  return (
    <>
      <p className="panel-note">
        {state.trades.length} operações fechadas, {pct(wins / state.trades.length)} com lucro, resultado{' '}
        <span className={tone(total)}>{signed(total)} {state.account.currency}</span>.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Fecho</th><th>Símbolo</th><th>Direção</th><th className="n">Lotes</th><th className="n">Entrada</th><th className="n">Saída</th><th>Motivo</th><th className="n">R</th><th className="n">Resultado</th></tr>
          </thead>
          <tbody>
            {state.trades.map((t) => {
              const spec = specOf(state, t.symbol);
              return (
                <tr key={`${t.id}-${t.closeTime}`}>
                  <td>{dayTime(t.closeTime)}</td>
                  <td className="strong">{t.symbol}</td>
                  <td>{sideLabel(t.direction)}</td>
                  <td className="n">{num(t.lots)}</td>
                  <td className="n">{price(t.entryPrice, spec)}</td>
                  <td className="n">{price(t.exitPrice, spec)}</td>
                  <td>{REASON[t.reason]}</td>
                  <td className={`n ${tone(t.rMultiple)}`}>{signed(t.rMultiple)}</td>
                  <td className={`n ${tone(t.pnl)}`}>{signed(t.pnl)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Strategies({ state, symbol }: { state: AppState; symbol: string }) {
  const rows = state.stats.filter((s) => s.symbol === symbol).sort((a, b) => b.weight - a.weight || b.winRate - a.winRate);
  if (!rows.length) return <p className="empty">O estratega ainda está a testar as estratégias em {symbol}.</p>;
  return (
    <>
      <p className="panel-note">
        Backtest em {symbol} sobre {state.mode === 'paper' ? 'dados sintéticos do simulador' : state.mode === 'live' ? 'histórico real aproximado' : 'o histórico enviado pelo corretor'}.
        Só vota quem tem expectativa positiva; o peso segue a taxa de acerto. Resultados passados não garantem resultados futuros.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Estratégia</th><th className="n">Ops.</th><th>Taxa de acerto</th><th className="n">Fator lucro</th><th className="n">Expectativa</th><th className="n">Queda</th><th className="n">Ao vivo</th><th className="n">Peso</th><th>Estado</th></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.strategy} className={s.benched ? 'is-benched' : ''}>
                <td className="strong">{STRATEGY_LABELS[s.strategy]}</td>
                <td className="n">{s.trades}</td>
                <td>
                  <span className="meter" aria-hidden><span style={{ inlineSize: `${Math.round(s.winRate * 100)}%` }} /></span>
                  <span className="meter-value">{pct(s.winRate)}</span>
                </td>
                <td className="n">{num(Math.min(s.profitFactor, 99))}</td>
                <td className={`n ${tone(s.expectancyR)}`}>{signed(s.expectancyR)} R</td>
                <td className="n">{num(s.maxDrawdownR, 1)} R</td>
                <td className="n">{s.liveTrades ? `${s.liveWins}/${s.liveTrades}` : '—'}</td>
                <td className="n">{s.benched ? '—' : num(s.weight)}</td>
                <td className="state">{s.benched ? `No banco, ${s.benchReason}` : 'A votar'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function News({ state }: { state: AppState }) {
  const { news } = state;
  const upcoming = news.events.filter((e) => e.time >= state.now - 30 * 60_000 && e.impact !== 'low').slice(0, 8);
  const sentiment = Object.entries(news.sentiment).sort((a, b) => b[1] - a[1]);
  const analyst = { llm: 'modelo de linguagem', lexicon: 'palavras-chave', simulated: 'simulado' }[news.analyst];
  return (
    <div className="news">
      <div>
        <h3>Calendário {news.source === 'simulated' ? 'simulado' : 'económico'}</h3>
        {news.source === 'unavailable' && <p className="empty">Calendário indisponível. Sem ele não há bloqueio antes de notícias.</p>}
        {news.source !== 'unavailable' && !upcoming.length && <p className="empty">Nada de relevante nas próximas horas.</p>}
        <ul className="events">
          {upcoming.map((e) => (
            <li key={e.id}>
              <time>{dayTime(e.time)}</time>
              <span className="strong">{e.currency}</span>
              <span>{e.title}</span>
              <span className={e.impact === 'high' ? 'impact impact-high' : 'impact'}>{e.impact === 'high' ? 'Alto impacto' : 'Médio'}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3>Sentimento por moeda ({analyst})</h3>
        {!sentiment.length && <p className="empty">Sem leitura de sentimento.</p>}
        <ul className="sentiment">
          {sentiment.map(([ccy, v]) => (
            <li key={ccy}>
              <span className="strong">{ccy}</span>
              <span className="diverge" aria-hidden>
                <span className={v >= 0 ? 'pos' : 'neg'} style={{ inlineSize: `${Math.abs(v) * 50}%` }} />
              </span>
              <span className={`n ${tone(v)}`}>{signed(v)}</span>
            </li>
          ))}
        </ul>
        {news.summary && <p className="panel-note">{news.summary}</p>}
        {news.headlines.length > 0 && (
          <ul className="headlines">
            {news.headlines.slice(0, 6).map((h) => <li key={h.id}><time>{hhmm(h.time)}</time> {h.title}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

const FIELDS: Array<{ key: keyof RiskSettings; label: string; hint: string; step: number }> = [
  { key: 'riskPerTradePct', label: 'Risco por operação (%)', hint: 'Parte do capital perdida se o stop for atingido', step: 0.05 },
  { key: 'maxDailyLossPct', label: 'Perda diária máxima (%)', hint: 'Atingido o limite, não há novas entradas nesse dia', step: 0.5 },
  { key: 'maxOpenPositions', label: 'Posições em simultâneo', hint: 'Total em todos os símbolos', step: 1 },
  { key: 'maxPerCurrency', label: 'Posições por moeda', hint: 'No mesmo sentido, por exemplo comprado em dólar', step: 1 },
  { key: 'minRewardRisk', label: 'Ganho/risco mínimo', hint: 'Distância ao alvo a dividir pela distância ao stop', step: 0.1 },
  { key: 'minConsensus', label: 'Consenso mínimo (0 a 1)', hint: 'Soma dos votos ponderados necessária para propor', step: 0.05 },
  { key: 'newsBlackoutMin', label: 'Bloqueio por notícias (min)', hint: 'Antes e depois de dados de alto impacto', step: 5 },
];

export function Risk({ state, desk }: { state: AppState; desk: DeskApi }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const dirty = Object.keys(draft).length > 0;
  return (
    <form
      className="risk"
      onSubmit={async (e) => {
        e.preventDefault();
        const patch = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v.replace(',', '.'))]).filter(([, v]) => Number.isFinite(v)));
        const res = await desk.saveRisk(patch);
        if (res.ok) { setDraft({}); setSaved(true); window.setTimeout(() => setSaved(false), 2500); }
      }}
    >
      <div className="risk-grid">
        {FIELDS.map((f) => (
          <label key={f.key}>
            <span>{f.label}</span>
            <input
              type="number" inputMode="decimal" step={f.step} min={0}
              value={draft[f.key] ?? String(state.risk[f.key])}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
            />
            <small>{f.hint}</small>
          </label>
        ))}
      </div>
      <div className="risk-actions">
        <button type="submit" className="btn btn-primary" disabled={!dirty}>Guardar limites</button>
        <span role="status" className="panel-note">{saved ? 'Limites guardados. O gestor de risco já os aplica.' : ''}</span>
      </div>
    </form>
  );
}

export function Equity({ points, currency }: { points: EquityPoint[]; currency: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const h = 200;
    const pad = { l: 8, r: 64, t: 12, b: 22 };
    const ys = points.map((p) => p.equity);
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    if (hi - lo < 1) { hi += 1; lo -= 1; }
    const span = hi - lo;
    lo -= span * 0.08;
    hi += span * 0.08;
    const x = (i: number) => pad.l + (i / (points.length - 1)) * (width - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join('');
    const ticks = [0, 0.5, 1].map((t) => lo + (hi - lo) * (0.08 / 1.16 + t * (1 / 1.16)));
    return { h, pad, x, y, path, ticks };
  }, [points, width]);

  if (!geo) return <p className="empty">A curva de capital aparece ao fim de algumas velas.</p>;
  const first = points[0];
  const last = points[points.length - 1];
  const at = hover ?? points.length - 1;
  const change = last.equity - first.equity;
  return (
    <div className="equity" ref={box}>
      <p className="panel-note">
        Capital {num(last.equity)} {currency}, <span className={tone(change)}>{signed(change)}</span> desde {dayTime(first.time)}.
      </p>
      <svg
        width={width} height={geo.h} role="img"
        aria-label={`Curva de capital: de ${num(first.equity)} para ${num(last.equity)} ${currency}`}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const f = (e.clientX - rect.left - geo.pad.l) / (width - geo.pad.l - geo.pad.r);
          setHover(Math.min(points.length - 1, Math.max(0, Math.round(f * (points.length - 1)))));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {geo.ticks.map((t) => (
          <g key={t}>
            <line x1={geo.pad.l} x2={width - geo.pad.r} y1={geo.y(t)} y2={geo.y(t)} className="grid" />
            <text x={width - geo.pad.r + 8} y={geo.y(t) + 4} className="axis">{num(t, 0)}</text>
          </g>
        ))}
        <text x={geo.pad.l} y={geo.h - 6} className="axis">{dayTime(first.time)}</text>
        <text x={width - geo.pad.r} y={geo.h - 6} className="axis" textAnchor="end">{dayTime(last.time)}</text>
        <path d={geo.path} className="line" />
        {hover !== null && <line x1={geo.x(at)} x2={geo.x(at)} y1={geo.pad.t} y2={geo.h - geo.pad.b} className="cross" />}
        <circle cx={geo.x(at)} cy={geo.y(points[at].equity)} r={4} className="dot" />
      </svg>
      {hover !== null && (
        <p className="tip" style={{ insetInlineStart: Math.min(width - 190, Math.max(0, geo.x(at) - 80)) }}>
          <span>{dayTime(points[at].time)}</span>
          <span className="strong">{num(points[at].equity)} {currency}</span>
        </p>
      )}
    </div>
  );
}
