import { Emitter } from '../emitter';
import type { Candle, ClosedTrade, CloseReason, Direction, Position, StrategyId, SymbolSpec, Tick } from '../../shared/types';

export interface OrderRequest {
  symbol: string;
  direction: Direction;
  lots: number;
  stopLoss: number;
  takeProfit: number;
  strategies: StrategyId[];
  note?: string;
}

export type BrokerEvents = {
  history: [symbol: string, candles: Candle[]];
  candle: [symbol: string, candle: Candle];
  tick: [tick: Tick];
  closed: [trade: ClosedTrade];
  spec: [spec: SymbolSpec];
  status: [];
};

/** What every execution venue must provide. Market data and fills arrive as events. */
export abstract class Broker extends Emitter<BrokerEvents> {
  abstract readonly name: string;
  abstract get connected(): boolean;
  /** Current time on the venue's clock, in milliseconds. */
  abstract now(): number;
  abstract start(): Promise<void>;
  abstract stop(): void;
  abstract account(): { balance: number; equity: number; currency: string };
  abstract positions(): Position[];
  abstract placeOrder(req: OrderRequest): Promise<Position>;
  abstract closePosition(id: string, reason: CloseReason): Promise<void>;
}
