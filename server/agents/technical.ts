import { STRATEGY_LABELS } from '../../shared/types';
import { evaluateLatest } from '../strategies';
import { fmt, side, type DeskContext } from './context';

/** Runs every strategy on each closed bar and forwards any setups to the coordinator. */
export function startTechnicalAgent(ctx: DeskContext): void {
  ctx.bus.on('market.candle', ({ symbol }: { symbol: string }) => {
    const candles = ctx.candles.get(symbol);
    const spec = ctx.specs.get(symbol);
    if (!candles || !spec) return;
    const signals = evaluateLatest(candles, spec);
    if (!signals.length) return;
    const parts = signals.map((s) => `${STRATEGY_LABELS[s.strategy]} indica ${side(s.direction)} (convicção ${fmt(s.confidence)})`);
    ctx.bus.publish({ from: 'technical', to: 'coordinator', topic: 'analysis.signals', symbol, data: { symbol, signals },
      text: `${symbol}: ${parts.join('; ')}. ${signals[0].rationale}.` });
  });
}
