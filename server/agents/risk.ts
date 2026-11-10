import type { AccountState, Direction, StrategyId } from '../../shared/types';
import { valuePerPrice } from '../symbols';
import { fmt, type DeskContext } from './context';

export interface Proposal {
  symbol: string;
  direction: Direction;
  stopLoss: number;
  takeProfit: number;
  strategies: StrategyId[];
  score: number;
  /** 0..1 multiplier the coordinator may apply to shrink the position. It can never grow it. */
  sizeFactor: number;
}

export interface RiskVerdict {
  approved: boolean;
  lots: number;
  riskAmount: number;
  reason: string;
}

/**
 * Last line of defence before an order leaves the desk. Sizes every trade from the stop distance
 * and refuses anything that breaks the account limits, whatever the other agents concluded.
 */
export function startRiskAgent(ctx: DeskContext): { account: () => AccountState } {
  const { bus, broker } = ctx;
  let day = -1;
  let dayStartBalance = 0;
  let halted = false;
  // Approved trades that have not reached the broker yet. Counting them as open stops two
  // symbols approved in the same instant from jointly exceeding the limits.
  const reserved = new Map<string, Direction>();
  bus.on('risk.release', ({ symbol }: { symbol: string }) => { reserved.delete(symbol); });

  function account(): AccountState {
    const a = broker.account();
    const today = Math.floor(broker.now() / 86_400_000);
    if (today !== day) {
      day = today;
      dayStartBalance = a.equity;
      halted = false;
    }
    return { ...a, dayStartBalance, dayPnl: a.equity - dayStartBalance };
  }

  function review(p: Proposal): RiskVerdict {
    const reject = (reason: string): RiskVerdict => ({ approved: false, lots: 0, riskAmount: 0, reason });
    const acc = account();
    const { risk } = ctx;
    const spec = ctx.specs.get(p.symbol);
    const tick = ctx.ticks.get(p.symbol);
    if (!spec || !tick) return reject('sem cotação para o símbolo');

    const lossLimit = (dayStartBalance * risk.maxDailyLossPct) / 100;
    if (acc.dayPnl <= -lossLimit) {
      if (!halted) {
        halted = true;
        bus.publish({ from: 'risk', to: 'all', topic: 'risk.halt', kind: 'warn',
          text: `Limite diário de perdas atingido (${fmt(acc.dayPnl)} ${acc.currency}). Sem novas entradas até ao próximo dia` });
      }
      return reject('limite diário de perdas atingido');
    }

    const open: Array<{ symbol: string; direction: Direction }> = broker.positions();
    for (const [symbol, direction] of reserved) {
      if (!open.some((o) => o.symbol === symbol)) open.push({ symbol, direction });
    }
    if (open.length >= risk.maxOpenPositions) return reject(`já há ${open.length} posições abertas (máximo ${risk.maxOpenPositions})`);
    if (open.some((o) => o.symbol === p.symbol)) return reject('já existe uma posição neste símbolo');

    // Count how many open trades already lean the same way on each currency of this pair.
    const exposure = (ccy: string, dir: Direction) => open.filter((o) => {
      const s = ctx.specs.get(o.symbol);
      if (!s) return false;
      return (s.base === ccy && o.direction === dir) || (s.quote === ccy && o.direction !== dir);
    }).length;
    const opposite: Direction = p.direction === 'long' ? 'short' : 'long';
    if (exposure(spec.base, p.direction) >= risk.maxPerCurrency) return reject(`exposição a ${spec.base} já no máximo`);
    if (exposure(spec.quote, opposite) >= risk.maxPerCurrency) return reject(`exposição a ${spec.quote} já no máximo`);

    const entry = p.direction === 'long' ? tick.ask : tick.bid;
    const stopDist = p.direction === 'long' ? entry - p.stopLoss : p.stopLoss - entry;
    const targetDist = p.direction === 'long' ? p.takeProfit - entry : entry - p.takeProfit;
    const spread = tick.ask - tick.bid;
    if (stopDist <= 0 || targetDist <= 0) return reject('o preço já passou o stop ou o alvo');
    if (stopDist < spread * 3) return reject('stop demasiado perto para o spread atual');
    const rr = targetDist / stopDist;
    if (rr < risk.minRewardRisk) return reject(`relação ganho/risco ${fmt(rr)} abaixo do mínimo ${fmt(risk.minRewardRisk)}`);

    const factor = Math.min(1, Math.max(0, p.sizeFactor));
    const riskAmount = ((acc.equity * risk.riskPerTradePct) / 100) * factor;
    const perLot = stopDist * valuePerPrice(spec, entry);
    const lots = Math.floor(riskAmount / perLot / spec.lotStep + 1e-9) * spec.lotStep;
    if (lots < spec.minLot) return reject(`risco de ${fmt(riskAmount)} ${acc.currency} não chega para o lote mínimo com este stop`);
    const rounded = Math.round(lots * 100) / 100;
    reserved.set(p.symbol, p.direction);
    return { approved: true, lots: rounded, riskAmount: rounded * perLot, reason: `ganho/risco ${fmt(rr)}` };
  }

  bus.handle('risk', 'risk.review', (p: Proposal) => {
    const v = review(p);
    const acc = broker.account();
    return {
      data: v,
      kind: v.approved ? 'reply' : 'warn',
      text: v.approved
        ? `Aprovado: ${fmt(v.lots)} lotes, risco ${fmt(v.riskAmount)} ${acc.currency} (${fmt((v.riskAmount / acc.equity) * 100)}% do capital), ${v.reason}`
        : `Rejeitado: ${v.reason}`,
    };
  });

  return { account };
}
