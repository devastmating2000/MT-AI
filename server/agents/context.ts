import type { Candle, Consensus, Mode, RiskSettings, SymbolSpec, Tick } from '../../shared/types';
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
  mode: Mode;
  /** Test switch: let strategies vote even when their record says they should sit out. */
  ignoreBench?: boolean;
}

export const fmt = (n: number, d = 2) => n.toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' } as Intl.NumberFormatOptions);
export const side = (d: 'long' | 'short') => (d === 'long' ? 'compra' : 'venda');
