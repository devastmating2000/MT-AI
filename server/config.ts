import type { Mode, RiskSettings } from '../shared/types';

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const mode: Mode = process.env.MTAI_MODE === 'mt5' ? 'mt5' : process.env.MTAI_MODE === 'live' ? 'live' : 'paper';

export const config = {
  mode,
  // Paper trading is always "on"; a real account stays signal-only until explicitly enabled.
  tradingEnabled: mode !== 'mt5' ? true : bool(process.env.MTAI_TRADING_ENABLED, false),
  bridgeToken: process.env.MTAI_BRIDGE_TOKEN ?? '',
  symbols: (process.env.MTAI_SYMBOLS ?? 'EURUSD,GBPUSD,USDJPY,XAUUSD,XAGUSD')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8787),
  simCandleMs: Math.max(200, Number(process.env.MTAI_SIM_CANDLE_MS ?? 2000)),
  simSeed: Number(process.env.MTAI_SIM_SEED ?? 20260),
  timeframeSec: Math.max(60, Number(process.env.MTAI_TIMEFRAME_SEC ?? 15 * 60)),
  llmModel: process.env.MTAI_LLM_MODEL ?? 'claude-opus-5-5',
  llmEnabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  newsFeeds: (process.env.MTAI_NEWS_FEEDS ?? 'https://www.fxstreet.com/rss/news')
    .split(',').map((s) => s.trim()).filter(Boolean),
  paperBalance: Number(process.env.MTAI_PAPER_BALANCE ?? 10_000),
};

export const defaultRisk: RiskSettings = {
  riskPerTradePct: 0.5,
  maxDailyLossPct: 3,
  maxOpenPositions: 3,
  maxPerCurrency: 2,
  minRewardRisk: 0.8,
  minConsensus: 0.35,
  newsBlackoutMin: 30,
};
