import { STRATEGY_LABELS, type ClosedTrade, type StrategyStats } from '../../shared/types';
import { assignWeights, backtestAll } from '../backtest/engine';
import { fmt, type DeskContext } from './context';

const REFRESH_EVERY = 96; // closed bars, one trading day on M15

/**
 * Backtests every strategy on each symbol's own history, turns the results into vote weights and
 * keeps them current as live trades close. Strategies that lose money on a symbol are benched.
 */
export function startStrategist(ctx: DeskContext): { stats: () => StrategyStats[] } {
  const { bus } = ctx;
  const bySymbol = new Map<string, StrategyStats[]>();
  const sinceRefresh = new Map<string, number>();

  function refresh(symbol: string, announce: boolean): void {
    const candles = ctx.candles.get(symbol);
    const spec = ctx.specs.get(symbol);
    if (!candles || !spec) return;
    const previous = bySymbol.get(symbol) ?? [];
    const fresh = backtestAll(candles, spec, ctx.broker.now()).map((s) => {
      const old = previous.find((p) => p.strategy === s.strategy);
      return { ...s, liveTrades: old?.liveTrades ?? 0, liveWins: old?.liveWins ?? 0 };
    });
    const stats = assignWeights(fresh);
    bySymbol.set(symbol, stats);
    sinceRefresh.set(symbol, 0);
    if (!announce || !stats.length) return;
    const active = stats.filter((s) => !s.benched).sort((a, b) => b.weight - a.weight);
    const benched = stats.filter((s) => s.benched).map((s) => STRATEGY_LABELS[s.strategy]);
    const best = active[0];
    const text = best
      ? `${symbol}: melhor estratégia ${STRATEGY_LABELS[best.strategy]} (${fmt(best.winRate * 100, 0)}% de acerto, fator de lucro ${fmt(best.profitFactor)}, ${best.trades} operações)`
        + (benched.length ? `. No banco: ${benched.join(', ')}` : '')
      : `${symbol}: nenhuma estratégia com expectativa positiva neste histórico; não voto neste símbolo`;
    bus.publish({ from: 'strategist', to: 'all', topic: 'strategy.report', symbol, kind: best ? 'info' : 'warn', text });
  }

  bus.on('market.history', ({ symbol }: { symbol: string }) => refresh(symbol, true));

  bus.on('market.candle', ({ symbol }: { symbol: string }) => {
    const n = (sinceRefresh.get(symbol) ?? 0) + 1;
    sinceRefresh.set(symbol, n);
    if (n >= REFRESH_EVERY) refresh(symbol, true);
  });

  bus.on('trade.closed', (trade: ClosedTrade) => {
    const stats = bySymbol.get(trade.symbol);
    if (!stats) return;
    for (const s of stats) {
      if (!trade.strategies.includes(s.strategy)) continue;
      s.liveTrades++;
      if (trade.pnl > 0) s.liveWins++;
    }
    bySymbol.set(trade.symbol, assignWeights(stats));
  });

  bus.handle('strategist', 'strategy.weights', ({ symbol }: { symbol: string }) => {
    let stats = bySymbol.get(symbol) ?? [];
    if (ctx.ignoreBench) stats = stats.map((s) => (s.benched ? { ...s, benched: false, weight: 1 } : s));
    const active = stats.filter((s) => !s.benched).sort((a, b) => b.weight - a.weight);
    return {
      data: stats,
      text: active.length
        ? `${symbol}: ${active.map((s) => `${STRATEGY_LABELS[s.strategy]} ${fmt(s.weight)}`).join(', ')}`
        : `${symbol}: todas as estratégias estão no banco`,
    };
  });

  return { stats: () => [...bySymbol.values()].flat() };
}
