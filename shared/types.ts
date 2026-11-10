// Types shared by the agent server and the React dashboard.

export type Direction = 'long' | 'short';
/** paper = synthetic prices; live = real quotes with simulated fills; mt5 = real account. */
export type Mode = 'paper' | 'live' | 'mt5';

export interface Candle {
  /** Bar open time, seconds since epoch (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  time: number;
}

export interface SymbolSpec {
  symbol: string;
  label: string;
  kind: 'forex' | 'metal';
  digits: number;
  /** Size of one pip in price units. */
  pip: number;
  contractSize: number;
  base: string;
  quote: string;
  spreadPips: number;
  minLot: number;
  lotStep: number;
  /** Account-currency value of a 1.0 price move for 1 lot, when the broker reports it. */
  valuePerPrice?: number;
}

export type StrategyId =
  | 'trend_pullback'
  | 'mean_reversion'
  | 'donchian_breakout'
  | 'macd_momentum'
  | 'session_breakout'
  | 'news_impulse';

export interface StrategySignal {
  strategy: StrategyId;
  symbol: string;
  direction: Direction;
  /** 0..1, the strategy's own conviction in this setup. */
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rationale: string;
  time: number;
}

export interface StrategyStats {
  strategy: StrategyId;
  symbol: string;
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  /** Average result per trade, in multiples of initial risk. */
  expectancyR: number;
  maxDrawdownR: number;
  avgRewardRisk: number;
  /** 0..1 vote weight the coordinator gives this strategy on this symbol. */
  weight: number;
  benched: boolean;
  benchReason?: string;
  liveTrades: number;
  liveWins: number;
  updatedAt: number;
}

export interface Position {
  id: string;
  symbol: string;
  direction: Direction;
  lots: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  openTime: number;
  pnl: number;
  strategies: StrategyId[];
  note?: string;
}

export type CloseReason = 'tp' | 'sl' | 'manual' | 'broker';

export interface ClosedTrade extends Position {
  exitPrice: number;
  closeTime: number;
  reason: CloseReason;
  rMultiple: number;
}

export interface AccountState {
  balance: number;
  equity: number;
  currency: string;
  dayPnl: number;
  dayStartBalance: number;
}

export interface RiskSettings {
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxOpenPositions: number;
  maxPerCurrency: number;
  minRewardRisk: number;
  /** Minimum weighted consensus score (0..1) before the coordinator proposes a trade. */
  minConsensus: number;
  newsBlackoutMin: number;
}

export type AgentId =
  | 'market'
  | 'technical'
  | 'news'
  | 'strategist'
  | 'coordinator'
  | 'event'
  | 'risk'
  | 'execution';

export interface AgentInfo {
  id: AgentId;
  name: string;
  role: string;
  status: 'idle' | 'working';
  lastNote: string;
  lastActivity: number;
  messages: number;
}

export type MessageKind = 'info' | 'request' | 'reply' | 'decision' | 'warn';

export interface AgentMessage {
  id: number;
  time: number;
  from: AgentId;
  to: AgentId | 'all';
  topic: string;
  kind: MessageKind;
  text: string;
  symbol?: string;
}

export interface NewsEvent {
  id: string;
  time: number;
  currency: string;
  title: string;
  impact: 'high' | 'medium' | 'low';
  forecast?: string;
  previous?: string;
}

export interface Headline {
  id: string;
  time: number;
  title: string;
  source: string;
}

export interface NewsState {
  source: 'simulated' | 'live' | 'unavailable';
  analyst: 'llm' | 'lexicon' | 'simulated';
  events: NewsEvent[];
  headlines: Headline[];
  /** -1 (bearish) .. +1 (bullish) per currency. */
  sentiment: Record<string, number>;
  summary: string;
  updatedAt: number;
}

export interface NewsBrief {
  symbol: string;
  blackout: boolean;
  reason: string;
  /** -1..+1 directional bias for the symbol (positive favours long). */
  bias: number;
}

export interface Consensus {
  symbol: string;
  direction: Direction | null;
  score: number;
  time: number;
  outcome: string;
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface AppState {
  mode: Mode;
  tradingEnabled: boolean;
  brokerConnected: boolean;
  brokerName: string;
  llm: { enabled: boolean; model: string };
  now: number;
  account: AccountState;
  symbols: SymbolSpec[];
  ticks: Record<string, Tick>;
  positions: Position[];
  trades: ClosedTrade[];
  stats: StrategyStats[];
  agents: AgentInfo[];
  news: NewsState;
  risk: RiskSettings;
  consensus: Record<string, Consensus>;
  equityCurve: EquityPoint[];
}

export type ServerEvent =
  | { type: 'state'; state: AppState }
  | { type: 'message'; message: AgentMessage }
  | { type: 'bar'; symbol: string; candle: Candle; closed: boolean };

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  trend_pullback: 'Recuo na tendência',
  mean_reversion: 'Reversão à média',
  donchian_breakout: 'Rutura Donchian',
  macd_momentum: 'Momentum MACD',
  session_breakout: 'Rutura de Londres',
  news_impulse: 'Impulso de notícia',
};
