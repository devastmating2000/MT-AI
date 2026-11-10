import type { Candle, ClosedTrade, CloseReason, Position, SymbolSpec } from '../../shared/types';
import { roundPrice, valuePerPrice } from '../symbols';
import { Broker, type OrderRequest } from './types';

export interface LiveOptions {
  balance: number;
  timeframeSec: number;
  pollMs?: number;
}

const YAHOO: Record<string, string> = { XAUUSD: 'GC=F', XAGUSD: 'SI=F' };
const UA = { 'user-agent': 'Mozilla/5.0' };

/**
 * Real market prices, simulated execution. Quotes are the public Swissquote bid/ask feed, polled
 * every couple of seconds; orders never leave this process. Fills happen at the quoted ask/bid,
 * a stop is filled at the price actually seen (so a gap costs what it would cost), a target at
 * its level. Use it to watch the desk on a live market without an account.
 *
 * Warm-up history comes from Yahoo. For metals that is the front futures contract, shifted by
 * its current difference to spot, so old bars are an approximation; bars built here are exact.
 */
export class LiveQuoteBroker extends Broker {
  readonly name = 'Cotações reais, execução simulada';
  private readonly open = new Map<string, Position>();
  private readonly forming = new Map<string, Candle>();
  private readonly last = new Map<string, { bid: number; ask: number; at: number }>();
  private balance: number;
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private lastOk = 0;
  errors = 0;
  polls = 0;

  constructor(private readonly specs: SymbolSpec[], private readonly opts: LiveOptions) {
    super();
    this.balance = opts.balance;
  }

  get connected(): boolean { return Date.now() - this.lastOk < 15_000; }
  now(): number { return Date.now(); }

  private async quote(spec: SymbolSpec): Promise<{ bid: number; ask: number }> {
    const url = `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${spec.base}/${spec.quote}`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`cotação respondeu ${res.status}`);
    const venues = (await res.json()) as Array<{ spreadProfilePrices: Array<{ spreadProfile: string; bid: number; ask: number }> }>;
    // Take the widest retail spread on offer: the least flattering, most realistic for a small account.
    let best: { bid: number; ask: number } | null = null;
    for (const v of venues) for (const p of v.spreadProfilePrices) {
      if (!(p.bid > 0 && p.ask > p.bid)) continue;
      if (!best || p.ask - p.bid > best.ask - best.bid) best = { bid: p.bid, ask: p.ask };
    }
    if (!best) throw new Error('cotação vazia');
    return best;
  }

  private async history(spec: SymbolSpec, mid: number): Promise<Candle[]> {
    const tf = this.opts.timeframeSec;
    const interval = tf <= 60 ? '1m' : tf <= 300 ? '5m' : '15m';
    const range = tf <= 60 ? '2d' : '1mo';
    const ticker = YAHOO[spec.symbol] ?? `${spec.symbol}=X`;
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`,
      { headers: UA, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`histórico respondeu ${res.status}`);
    const r = ((await res.json()) as any).chart.result[0];
    const q = r.indicators.quote[0];
    const current = Math.floor(Date.now() / 1000 / tf) * tf;
    const bars: Candle[] = [];
    (r.timestamp as number[]).forEach((t, i) => {
      const time = Math.floor(t / tf) * tf;
      if (q.close[i] == null || q.open[i] == null || time >= current) return;
      const prev = bars[bars.length - 1];
      if (prev && prev.time === time) return;
      bars.push({ time, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] ?? 0 });
    });
    if (!bars.length) throw new Error('histórico vazio');
    // Futures trade at a premium to spot; slide the whole series so it ends at today's spot price.
    const shift = mid - bars[bars.length - 1].close;
    return bars.slice(-1200).map((b) => ({ ...b, open: b.open + shift, high: b.high + shift, low: b.low + shift, close: b.close + shift }));
  }

  async start(): Promise<void> {
    for (const spec of this.specs) {
      const q = await this.quote(spec);
      // Backtests must pay the spread this market really charges right now.
      spec.spreadPips = (q.ask - q.bid) / spec.pip;
      this.emit('spec', { ...spec });
      this.emit('history', spec.symbol, await this.history(spec, (q.bid + q.ask) / 2));
    }
    this.lastOk = Date.now();
    this.timer = setInterval(() => { void this.poll(); }, this.opts.pollMs ?? 2000);
    await this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    const tf = this.opts.timeframeSec;
    await Promise.all(this.specs.map(async (spec) => {
      this.polls++;
      let q: { bid: number; ask: number };
      try {
        q = await this.quote(spec);
      } catch {
        this.errors++;
        return;
      }
      this.lastOk = Date.now();
      const now = Date.now();
      this.last.set(spec.symbol, { ...q, at: now });
      const mid = (q.bid + q.ask) / 2;
      const open = Math.floor(now / 1000 / tf) * tf;
      const bar = this.forming.get(spec.symbol);
      if (bar && bar.time !== open) {
        this.forming.delete(spec.symbol);
        this.emit('candle', spec.symbol, { ...bar });
      }
      const cur = this.forming.get(spec.symbol);
      if (!cur) this.forming.set(spec.symbol, { time: open, open: mid, high: mid, low: mid, close: mid, volume: 1 });
      else { cur.high = Math.max(cur.high, mid); cur.low = Math.min(cur.low, mid); cur.close = mid; cur.volume++; }
      this.mark(spec, q.bid, q.ask);
      this.emit('tick', { symbol: spec.symbol, bid: q.bid, ask: q.ask, time: now });
    }));
  }

  private pnl(p: Position, exit: number, spec: SymbolSpec): number {
    return (p.direction === 'long' ? exit - p.entryPrice : p.entryPrice - exit) * p.lots * valuePerPrice(spec, exit);
  }

  private mark(spec: SymbolSpec, bid: number, ask: number): void {
    for (const p of [...this.open.values()]) {
      if (p.symbol !== spec.symbol) continue;
      const px = p.direction === 'long' ? bid : ask;
      p.pnl = this.pnl(p, px, spec);
      const stopped = p.direction === 'long' ? px <= p.stopLoss : px >= p.stopLoss;
      const target = p.direction === 'long' ? px >= p.takeProfit : px <= p.takeProfit;
      if (stopped) this.settle(p, px, 'sl', spec);
      else if (target) this.settle(p, p.takeProfit, 'tp', spec);
    }
  }

  private settle(p: Position, exit: number, reason: CloseReason, spec: SymbolSpec): void {
    const pnl = this.pnl(p, exit, spec);
    const risk = Math.abs(p.entryPrice - p.stopLoss);
    const move = p.direction === 'long' ? exit - p.entryPrice : p.entryPrice - exit;
    this.open.delete(p.id);
    this.balance += pnl;
    this.emit('closed', { ...p, pnl, exitPrice: roundPrice(spec, exit), closeTime: Date.now(), reason, rMultiple: risk > 0 ? move / risk : 0 } satisfies ClosedTrade);
  }

  account() {
    let floating = 0;
    for (const p of this.open.values()) floating += p.pnl;
    return { balance: this.balance, equity: this.balance + floating, currency: 'USD' };
  }

  positions(): Position[] { return [...this.open.values()].map((p) => ({ ...p })); }

  private fresh(symbol: string): { bid: number; ask: number; spec: SymbolSpec } {
    const spec = this.specs.find((s) => s.symbol === symbol);
    const q = this.last.get(symbol);
    if (!spec || !q) throw new Error(`sem cotação para ${symbol}`);
    if (Date.now() - q.at > 10_000) throw new Error('cotação desatualizada');
    return { ...q, spec };
  }

  async placeOrder(req: OrderRequest): Promise<Position> {
    const { bid, ask, spec } = this.fresh(req.symbol);
    const p: Position = {
      id: `L${this.nextId++}`, symbol: req.symbol, direction: req.direction, lots: req.lots,
      entryPrice: roundPrice(spec, req.direction === 'long' ? ask : bid),
      stopLoss: roundPrice(spec, req.stopLoss), takeProfit: roundPrice(spec, req.takeProfit),
      openTime: Date.now(), pnl: 0, strategies: req.strategies, note: req.note,
    };
    p.pnl = this.pnl(p, req.direction === 'long' ? bid : ask, spec);
    this.open.set(p.id, p);
    return { ...p };
  }

  async closePosition(id: string, reason: CloseReason): Promise<void> {
    const p = this.open.get(id);
    if (!p) throw new Error(`Posição ${id} não encontrada`);
    const { bid, ask, spec } = this.fresh(p.symbol);
    this.settle(p, p.direction === 'long' ? bid : ask, reason, spec);
  }
}
