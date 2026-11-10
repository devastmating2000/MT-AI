import type { ClosedTrade, Position } from '../../shared/types';
import type { OrderRequest } from '../broker/types';
import { fmt, side, type DeskContext } from './context';

const REASONS: Record<ClosedTrade['reason'], string> = { tp: 'alvo atingido', sl: 'stop atingido', manual: 'fecho manual', broker: 'fechada no corretor' };

/** The only agent allowed to talk to the broker. Reports fills and closed trades back to the desk. */
export function startExecutionAgent(ctx: DeskContext): { trades: () => ClosedTrade[] } {
  const { bus, broker } = ctx;
  const trades: ClosedTrade[] = [];

  bus.handle('execution', 'execution.order', async (req: OrderRequest) => {
    const spec = ctx.specs.get(req.symbol)!;
    try {
      const pos = await broker.placeOrder(req);
      return {
        data: pos as Position | null, kind: 'decision' as const,
        text: `${req.symbol}: ${side(pos.direction)} de ${fmt(pos.lots)} lotes executada a ${pos.entryPrice.toFixed(spec.digits)}; stop ${pos.stopLoss.toFixed(spec.digits)}, alvo ${pos.takeProfit.toFixed(spec.digits)}`,
      };
    } catch (err) {
      return { data: null, kind: 'warn' as const, text: `${req.symbol}: ordem recusada pelo corretor (${err instanceof Error ? err.message : String(err)})` };
    }
  });

  broker.on('closed', (trade) => {
    trades.push(trade);
    if (trades.length > 300) trades.shift();
    const { currency } = broker.account();
    bus.publish({ from: 'execution', to: 'all', topic: 'trade.closed', symbol: trade.symbol, data: trade,
      kind: trade.pnl >= 0 ? 'decision' : 'warn',
      text: `${trade.symbol}: ${side(trade.direction)} fechada, ${REASONS[trade.reason]}. Resultado ${trade.pnl >= 0 ? '+' : ''}${fmt(trade.pnl)} ${currency} (${trade.rMultiple >= 0 ? '+' : ''}${fmt(trade.rMultiple)}R)` });
  });

  return { trades: () => trades };
}
