import type { Candle, ClosedTrade, Direction, NewsEvent, StrategySignal, StrategyStats } from '../../shared/types';
import { atr } from '../strategies/indicators';
import { fmt, side, type DeskContext } from './context';

/** Bar range, in multiples of the average range, that counts as a real reaction to a release. */
export const MIN_IMPULSE = 1.8;
const PROVISIONAL_WEIGHT = 0.7;
const MAX_TRADES_PER_EVENT = 2;

export interface Reaction {
  direction: Direction;
  /** Release-bar range divided by the ATR of the bars before it. */
  ratio: number;
  range: number;
  atr: number;
}

/**
 * Read the bar in which a release landed. It only counts as a reaction when the bar is far
 * larger than usual and closed decisively one way; a big bar that closed back in the middle is
 * a whipsaw and is ignored.
 */
export function readReaction(candles: Candle[]): Reaction | null {
  if (candles.length < 30) return null;
  const bar = candles[candles.length - 1];
  const before = atr(candles.slice(-41, -1), 14).at(-1) ?? NaN;
  const range = bar.high - bar.low;
  const body = bar.close - bar.open;
  if (!(before > 0) || range < MIN_IMPULSE * before || Math.abs(body) < 0.5 * range) return null;
  return { direction: body > 0 ? 'long' : 'short', ratio: range / before, range, atr: before };
}

/** For most releases a higher number helps the currency; for unemployment data it hurts. */
function higherIsBullish(title: string): boolean {
  return !/unemploy|jobless|claims|desemprego/i.test(title);
}

const lisbon = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' });

/**
 * Specialist for high-impact data days (US CPI, payrolls, rate decisions; usually 13:30 in
 * Lisbon). Nobody can know the number in advance, so it does not guess before the release.
 * It waits for the release bar to close, checks that the move is large, one-sided and
 * confirmed across the symbols that share the currency, and then trades with the move.
 */
export function startEventAgent(ctx: DeskContext): { stats: () => StrategyStats[] } {
  const { bus, broker } = ctx;
  const watching = new Map<string, { event: NewsEvent; readings: Map<string, Reaction | null> }>();
  const records = new Map<string, { trades: number; wins: number; sumR: number; grossWin: number; grossLoss: number }>();

  function symbolsFor(currency: string): string[] {
    return [...ctx.specs.values()].filter((s) => s.base === currency || s.quote === currency).map((s) => s.symbol);
  }

  function stat(symbol: string): StrategyStats {
    const r = records.get(symbol) ?? { trades: 0, wins: 0, sumR: 0, grossWin: 0, grossLoss: 0 };
    // No calendar history exists to backtest against, so the record is built from live trades.
    const benched = r.trades >= 6 && r.sumR <= 0;
    return {
      strategy: 'news_impulse', symbol, trades: r.trades, wins: r.wins, winRate: r.trades ? r.wins / r.trades : 0,
      profitFactor: r.grossLoss > 0 ? r.grossWin / r.grossLoss : r.grossWin > 0 ? 99 : 0,
      expectancyR: r.trades ? r.sumR / r.trades : 0, maxDrawdownR: 0, avgRewardRisk: 1.5,
      weight: benched ? 0 : PROVISIONAL_WEIGHT, benched, benchReason: benched ? 'resultado ao vivo negativo' : undefined,
      liveTrades: r.trades, liveWins: r.wins, updatedAt: broker.now(),
    };
  }

  // The news analyst announces each high-impact release an hour ahead; that is the cue to prepare.
  bus.on('news.event', (event: NewsEvent) => {
    const symbols = symbolsFor(event.currency);
    if (!symbols.length || watching.has(event.id)) return;
    watching.set(event.id, { event, readings: new Map() });
    const strong = symbols.map((s) => `${side(ctx.specs.get(s)!.base === event.currency ? 'long' : 'short')} em ${s}`).join(', ');
    bus.publish({ from: 'event', to: 'all', topic: 'event.plan',
      text: `${event.title} às ${lisbon.format(event.time)} (hora de Lisboa). Vigio ${symbols.join(', ')}. `
        + `Um valor ${higherIsBullish(event.title) ? 'acima' : 'abaixo'} do previsto costuma fortalecer o ${event.currency} (${strong}); o contrário inverte. `
        + `Não adivinho o número: só entro depois de a vela da notícia fechar com pelo menos ${fmt(MIN_IMPULSE, 1)}× a amplitude média, na mesma direção em vários pares` });
  });

  bus.on('market.candle', ({ symbol, candle }: { symbol: string; candle: Candle }) => {
    const list = ctx.candles.get(symbol);
    const spec = ctx.specs.get(symbol);
    if (!list || !spec) return;
    const tf = list.length > 1 ? list[list.length - 1].time - list[list.length - 2].time : 900;
    for (const [id, watch] of watching) {
      const at = watch.event.time / 1000;
      if (candle.time > at + tf) { watching.delete(id); continue; } // release bar missed
      if (at < candle.time || at >= candle.time + tf) continue;
      const symbols = symbolsFor(watch.event.currency);
      if (!symbols.includes(symbol)) continue;
      watch.readings.set(symbol, readReaction(list));
      if (watch.readings.size < symbols.length) continue;
      watching.delete(id);
      conclude(watch.event, watch.readings);
    }
  });

  function conclude(event: NewsEvent, readings: Map<string, Reaction | null>): void {
    // Translate each symbol's move into "currency stronger (+1) or weaker (-1)".
    const moves = [...readings].flatMap(([symbol, r]) => {
      if (!r) return [];
      const base = ctx.specs.get(symbol)!.base === event.currency;
      return [{ symbol, r, currency: (r.direction === 'long') === base ? 1 : -1 }];
    });
    const net = moves.reduce((a, m) => a + m.currency, 0);
    if (!moves.length || net === 0) {
      bus.publish({ from: 'event', to: 'all', topic: 'event.pass',
        text: `${event.title}: ${moves.length ? 'os pares reagiram em sentidos opostos' : 'sem reação clara na vela da notícia'}. Fico de fora` });
      return;
    }
    const agreeing = moves.filter((m) => m.currency === Math.sign(net)).sort((a, b) => b.r.ratio - a.r.ratio);
    bus.publish({ from: 'event', to: 'coordinator', topic: 'event.read', kind: 'decision',
      text: `${event.title}: ${event.currency} ${net > 0 ? 'mais forte' : 'mais fraco'}, confirmado em ${agreeing.length} de ${readings.size} símbolos. `
        + agreeing.map((m) => `${m.symbol} ${fmt(m.r.ratio, 1)}× a amplitude média`).join(', ') });

    for (const m of agreeing.slice(0, MAX_TRADES_PER_EVENT)) {
      const record = stat(m.symbol);
      if (record.benched) continue;
      const close = ctx.candles.get(m.symbol)!.at(-1)!.close;
      const sign = m.r.direction === 'long' ? 1 : -1;
      // Stop behind half of the release bar: if the move gives that much back, the read was wrong.
      const stop = Math.max(0.5 * m.r.range, m.r.atr);
      const signal: StrategySignal = {
        strategy: 'news_impulse', symbol: m.symbol, direction: m.r.direction,
        confidence: Math.min(0.95, 0.55 + 0.08 * (m.r.ratio - MIN_IMPULSE) + 0.1 * (agreeing.length - 1)),
        entry: close, stopLoss: close - sign * stop, takeProfit: close + sign * 1.5 * stop,
        rationale: `Vela da notícia com ${fmt(m.r.ratio, 1)}× a amplitude média, fecho decidido para ${side(m.r.direction)}`,
        time: broker.now(),
      };
      bus.publish({ from: 'event', to: 'coordinator', topic: 'event.signals', symbol: m.symbol,
        data: { symbol: m.symbol, signals: [signal], event: { stat: record, title: event.title } },
        text: `${m.symbol}: proponho ${side(m.r.direction)} a seguir a ${event.title}, convicção ${fmt(signal.confidence)}` });
    }
  }

  bus.on('trade.closed', (trade: ClosedTrade) => {
    if (!trade.strategies.includes('news_impulse')) return;
    const r = records.get(trade.symbol) ?? { trades: 0, wins: 0, sumR: 0, grossWin: 0, grossLoss: 0 };
    const wasBenched = stat(trade.symbol).benched;
    r.trades++;
    if (trade.rMultiple > 0) { r.wins++; r.grossWin += trade.rMultiple; } else r.grossLoss -= trade.rMultiple;
    r.sumR += trade.rMultiple;
    records.set(trade.symbol, r);
    if (!wasBenched && stat(trade.symbol).benched) {
      bus.publish({ from: 'event', to: 'all', topic: 'event.bench', kind: 'warn', symbol: trade.symbol,
        text: `${trade.symbol}: ${r.trades} operações em notícias com resultado negativo (${fmt(r.sumR)}R). Deixo de negociar eventos neste símbolo` });
    }
  });

  return { stats: () => [...ctx.specs.keys()].map(stat).filter((s) => s.trades > 0) };
}
