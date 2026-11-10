import type { Candle, Consensus, RiskSettings, SymbolSpec, Tick } from '../../shared/types';
import type { Broker } from '../broker/types';
import type { MessageBus } from '../bus';

/** Shared, read-mostly desk state handed to every agent. */
export interface DeskContext {
  bus: MessageBus;
  broker: Broker;
  specs: Map<string, SymbolSpec>;
  candles: Map<string, Candle[]>;
  ticks: Map<string, Tick>;
  risk: RiskSettings;
  consensus: Map<string, Consensus>;
  tradingEnabled: boolean;
  mode: 'paper' | 'mt5';
}

export const fmt = (n: number, d = 2) => n.toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d });
export const side = (d: 'long' | 'short') => (d === 'long' ? 'compra' : 'venda');
