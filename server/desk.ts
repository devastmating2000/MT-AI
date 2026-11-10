import type { AppState, Candle, Consensus, EquityPoint, RiskSettings, ServerEvent, SymbolSpec, Tick } from '../shared/types';
import { startCoordinator } from './agents/coordinator';
import { startEventAgent } from './agents/event';
import type { DeskContext } from './agents/context';
import { startExecutionAgent } from './agents/execution';
import { startMarketAgent } from './agents/market';
import { startNewsAgent } from './agents/news';
import { startRiskAgent } from './agents/risk';
import { startStrategist } from './agents/strategist';
import { startTechnicalAgent } from './agents/technical';
import type { Broker } from './broker/types';
import { MessageBus } from './bus';
import { defaultRisk } from './config';
import { llmStatus } from './llm/client';
import { specFor } from './symbols';

export interface DeskOptions {
  mode: 'paper' | 'mt5';
  symbols: string[];
  tradingEnabled: boolean;
  risk?: Partial<RiskSettings>;
}

/** Wires the broker, the message bus and the agents together. */
export class Desk {
  readonly bus: MessageBus;
  readonly ctx: DeskContext;
  private readonly forming = new Map<string, Candle>();
  private readonly equity: EquityPoint[] = [];
  private readonly parts: {
    strategist: ReturnType<typeof startStrategist>;
    news: ReturnType<typeof startNewsAgent>;
    risk: ReturnType<typeof startRiskAgent>;
    execution: ReturnType<typeof startExecutionAgent>;
    event: ReturnType<typeof startEventAgent>;
  };
  onEvent: (event: ServerEvent) => void = () => {};

  constructor(readonly broker: Broker, private readonly opts: DeskOptions) {
    this.bus = new MessageBus(() => broker.now());
    this.bus.onMessage = (message) => this.onEvent({ type: 'message', message });
    this.ctx = {
      bus: this.bus, broker, mode: opts.mode, tradingEnabled: opts.tradingEnabled,
      specs: new Map<string, SymbolSpec>(opts.symbols.map((s) => [s, specFor(s)])),
      candles: new Map<string, Candle[]>(), ticks: new Map<string, Tick>(),
      risk: { ...defaultRisk, ...opts.risk }, consensus: new Map<string, Consensus>(),
    };

    broker.on('spec', (spec) => { if (this.ctx.specs.has(spec.symbol)) this.ctx.specs.set(spec.symbol, spec); });
    broker.on('tick', (tick) => this.onTick(tick));
    broker.on('candle', (symbol, candle) => {
      this.forming.delete(symbol);
      this.onEvent({ type: 'bar', symbol, candle, closed: true });
      if (symbol === opts.symbols[0]) this.sampleEquity();
    });

    // Order matters only for readability: each agent subscribes to what it needs.
    startMarketAgent(this.ctx);
    this.parts = {
      strategist: startStrategist(this.ctx),
      news: startNewsAgent(this.ctx),
      risk: startRiskAgent(this.ctx),
      execution: startExecutionAgent(this.ctx),
      event: startEventAgent(this.ctx),
    };
    startTechnicalAgent(this.ctx);
    startCoordinator(this.ctx);
  }

  /** Build the bar that is still forming from ticks, so the chart moves between closes. */
  private onTick(tick: Tick): void {
    const spec = this.ctx.specs.get(tick.symbol);
    const list = this.ctx.candles.get(tick.symbol);
    if (!spec || !list?.length) return;
    const tf = list.length > 1 ? list[list.length - 1].time - list[list.length - 2].time : 900;
    const mid = (tick.bid + tick.ask) / 2;
    const open = Math.max(list[list.length - 1].time + tf, Math.floor(tick.time / 1000 / tf) * tf);
    let bar = this.forming.get(tick.symbol);
    if (!bar || bar.time !== open) bar = { time: open, open: mid, high: mid, low: mid, close: mid, volume: 0 };
    bar.high = Math.max(bar.high, mid);
    bar.low = Math.min(bar.low, mid);
    bar.close = mid;
    bar.volume++;
    this.forming.set(tick.symbol, bar);
    this.onEvent({ type: 'bar', symbol: tick.symbol, candle: bar, closed: false });
  }

  private sampleEquity(): void {
    this.equity.push({ time: this.broker.now(), equity: this.broker.account().equity });
    if (this.equity.length > 800) this.equity.shift();
  }

  setTrading(enabled: boolean): void {
    this.ctx.tradingEnabled = enabled;
    this.bus.publish({ from: 'coordinator', to: 'all', topic: 'desk.trading', kind: enabled ? 'decision' : 'warn',
      text: enabled ? 'Negociação retomada pelo operador' : 'Negociação em pausa pelo operador. Continuo a analisar, sem enviar ordens' });
  }

  setRisk(patch: Partial<RiskSettings>): RiskSettings {
    const bounds: Record<keyof RiskSettings, [number, number]> = {
      riskPerTradePct: [0.05, 5], maxDailyLossPct: [0.5, 20], maxOpenPositions: [1, 10], maxPerCurrency: [1, 5],
      minRewardRisk: [0.3, 5], minConsensus: [0.05, 1], newsBlackoutMin: [0, 240],
    };
    for (const key of Object.keys(bounds) as Array<keyof RiskSettings>) {
      const v = Number(patch[key]);
      if (patch[key] === undefined || !Number.isFinite(v)) continue;
      this.ctx.risk[key] = Math.min(bounds[key][1], Math.max(bounds[key][0], v));
    }
    this.bus.publish({ from: 'risk', to: 'all', topic: 'risk.settings',
      text: `Limites atualizados: ${this.ctx.risk.riskPerTradePct}% por operação, perda diária máxima ${this.ctx.risk.maxDailyLossPct}%, até ${this.ctx.risk.maxOpenPositions} posições` });
    return this.ctx.risk;
  }

  candles(symbol: string): Candle[] {
    const list = this.ctx.candles.get(symbol) ?? [];
    const forming = this.forming.get(symbol);
    return forming ? [...list, forming] : list;
  }

  state(): AppState {
    return {
      mode: this.opts.mode,
      tradingEnabled: this.ctx.tradingEnabled,
      brokerConnected: this.broker.connected,
      brokerName: this.broker.name,
      llm: llmStatus(),
      now: this.broker.now(),
      account: this.parts.risk.account(),
      symbols: [...this.ctx.specs.values()],
      ticks: Object.fromEntries(this.ctx.ticks),
      positions: this.broker.positions(),
      trades: this.parts.execution.trades().slice(-100).reverse(),
      stats: [...this.parts.strategist.stats(), ...this.parts.event.stats()],
      agents: this.bus.roster(),
      news: this.parts.news.state(),
      risk: this.ctx.risk,
      consensus: Object.fromEntries(this.ctx.consensus),
      equityCurve: this.equity,
    };
  }
}
