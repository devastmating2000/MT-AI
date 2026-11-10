import type { Mode, RiskSettings } from '../shared/types';

// In the browser demo there is no process; every setting falls back to its default.
const env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {};

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const mode: Mode = env.MTAI_MODE === 'mt5' ? 'mt5' : env.MTAI_MODE === 'live' ? 'live' : 'paper';

export const config = {
  mode,
  // Paper trading is always "on"; a real account stays signal-only until explicitly enabled.
  tradingEnabled: mode !== 'mt5' ? true : bool(env.MTAI_TRADING_ENABLED, false),
  bridgeToken: env.MTAI_BRIDGE_TOKEN ?? '',
  symbols: (env.MTAI_SYMBOLS ?? 'EURUSD,GBPUSD,USDJPY,XAUUSD,XAGUSD')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  host: env.HOST ?? '127.0.0.1',
  port: Number(env.PORT ?? 8787),
  simCandleMs: Math.max(200, Number(env.MTAI_SIM_CANDLE_MS ?? 2000)),
  simSeed: Number(env.MTAI_SIM_SEED ?? 20260),
  timeframeSec: Math.max(60, Number(env.MTAI_TIMEFRAME_SEC ?? 15 * 60)),
  llmModel: env.MTAI_LLM_MODEL ?? 'claude-opus-5-5',
  llmEnabled: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
  newsFeeds: (env.MTAI_NEWS_FEEDS ?? 'https://www.fxstreet.com/rss/news')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // --- access control ---------------------------------------------------------------------
  /** Postgres connection string (Neon). When set, the dashboard and API require a login. */
  databaseUrl: env.DATABASE_URL ?? '',
  /** First-run bootstrap: creates this operator when the database has none. */
  adminEmail: (env.MTAI_ADMIN_EMAIL ?? '').trim().toLowerCase(),
  adminPassword: env.MTAI_ADMIN_PASSWORD ?? '',
  allowedOrigins: (env.MTAI_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  /** Number of reverse proxies in front of the server (0 = clients connect directly). */
  trustProxy: Number(env.MTAI_TRUST_PROXY ?? 0),
  hsts: ['1', 'true'].includes((env.MTAI_HSTS ?? '').toLowerCase()),
  paperBalance: Number(env.MTAI_PAPER_BALANCE ?? 10_000),
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
