import type { Candle } from '../../shared/types';
import { atr } from '../strategies/indicators';
import { fmt, type DeskContext } from './context';

const MAX_BARS = 1500;

/** Owns the candle store and announces every closed bar to the rest of the desk. */
export function startMarketAgent(ctx: DeskContext): void {
  const { bus, broker } = ctx;

  broker.on('history', (symbol, candles) => {
    ctx.candles.set(symbol, candles.slice(-MAX_BARS));
    bus.publish({ from: 'market', to: 'all', topic: 'market.history', symbol, data: { symbol },
      text: `${symbol}: ${candles.length} velas M15 de histórico carregadas` });
  });

  broker.on('tick', (tick) => ctx.ticks.set(tick.symbol, tick));

  broker.on('candle', (symbol, candle: Candle) => {
    const list = ctx.candles.get(symbol) ?? [];
    if (list.length && list[list.length - 1].time >= candle.time) return;
    list.push(candle);
    if (list.length > MAX_BARS) list.splice(0, list.length - MAX_BARS);
    ctx.candles.set(symbol, list);
    bus.publish({ from: 'market', to: 'all', topic: 'market.candle', symbol, data: { symbol, candle }, text: '', silent: true });

    // Only speak up when a bar is unusually large; routine closes would drown the conversation.
    if (list.length > 30) {
      const a = atr(list.slice(-40), 14).at(-2) ?? NaN;
      const range = candle.high - candle.low;
      if (a > 0 && range > 3 * a) {
        const spec = ctx.specs.get(symbol)!;
        bus.publish({ from: 'market', to: 'all', topic: 'market.alert', kind: 'warn', symbol,
          text: `${symbol}: vela de ${fmt(range / spec.pip, 0)} pips, ${fmt(range / a, 1)}× a amplitude média` });
      }
    }
  });
}
