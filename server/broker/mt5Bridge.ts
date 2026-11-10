import type { Candle, ClosedTrade, CloseReason, Position, StrategyId, SymbolSpec } from '../../shared/types';
import { specFor } from '../symbols';
import { Broker, type OrderRequest } from './types';

interface Pending {
  line: string;
  sent: boolean;
  resolve: (r: { ticket: string; price: number }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const HISTORY_BARS = 1000;
const ORDER_TIMEOUT_MS = 20_000;

/**
 * MetaTrader 5 venue. MT5 has no network API of its own, so the Expert Advisor in
 * mt5/MTAI_Bridge.mq5 polls this process over HTTP about once a second: it posts quotes, closed
 * bars, positions and order results, and the response carries the commands it should execute.
 *
 * Wire format: one record per line, fields separated by "|" (see "Protocolo da ponte" in the README).
 */
export class Mt5BridgeBroker extends Broker {
  readonly name = 'MetaTrader 5';
  private lastSync = 0;
  private acc = { balance: 0, equity: 0, currency: 'USD' };
  private readonly open = new Map<string, Position>();
  private readonly meta = new Map<string, { strategies: StrategyId[]; note?: string }>();
  private readonly pending = new Map<string, Pending>();
  private readonly historyBuffer = new Map<string, Candle[]>();
  private readonly haveHistory = new Set<string>();
  private readonly lastBar = new Map<string, number>();
  private nextCmd = 1;

  constructor(private readonly symbols: string[]) {
    super();
  }

  get connected(): boolean { return Date.now() - this.lastSync < 10_000; }
  now(): number { return Date.now(); }
  async start(): Promise<void> {}
  stop(): void {}
  account() { return { ...this.acc }; }
  positions(): Position[] { return [...this.open.values()].map((p) => ({ ...p })); }

  /** Process one poll from the Expert Advisor and return the commands for it to run. */
  sync(body: string): string {
    const wasConnected = this.connected;
    this.lastSync = Date.now();
    const seen = new Set<string>();
    let sawPositions = false;

    for (const raw of body.split('\n')) {
      const f = raw.trim().split('|');
      const num = (i: number) => Number(f[i]);
      switch (f[0]) {
        case 'ACCOUNT':
          this.acc = { balance: num(1), equity: num(2), currency: f[3] || 'USD' };
          break;
        case 'SPEC': {
          const base = specFor(f[1]);
          const tickSize = num(8);
          const spec: SymbolSpec = {
            ...base, digits: num(2), contractSize: num(4), minLot: num(5), lotStep: num(6),
            valuePerPrice: tickSize > 0 ? num(7) / tickSize : undefined,
          };
          this.emit('spec', spec);
          break;
        }
        case 'TICK':
          if (num(2) > 0) this.emit('tick', { symbol: f[1], bid: num(2), ask: num(3), time: num(4) * 1000 });
          break;
        case 'HIST': {
          const list = this.historyBuffer.get(f[1]) ?? [];
          list.push(this.bar(f));
          this.historyBuffer.set(f[1], list);
          break;
        }
        case 'BAR': {
          const bar = this.bar(f);
          if (this.haveHistory.has(f[1]) && bar.time > (this.lastBar.get(f[1]) ?? 0)) {
            this.lastBar.set(f[1], bar.time);
            this.emit('candle', f[1], bar);
          }
          break;
        }
        case 'POS': {
          sawPositions = true;
          const id = f[1];
          seen.add(id);
          const m = this.meta.get(id);
          this.open.set(id, {
            id, symbol: f[2], direction: f[3] === 'BUY' ? 'long' : 'short', lots: num(4), entryPrice: num(5),
            stopLoss: num(6), takeProfit: num(7), pnl: num(8), openTime: num(9) * 1000,
            strategies: m?.strategies ?? [], note: m?.note,
          });
          break;
        }
        case 'POSITIONS':
          sawPositions = true; // sent with a count, so an empty book is distinguishable from no report
          break;
        case 'RESULT': {
          const p = this.pending.get(f[1]);
          if (!p) break;
          clearTimeout(p.timer);
          this.pending.delete(f[1]);
          if (f[2] === 'OK') p.resolve({ ticket: f[3], price: num(4) });
          else p.reject(new Error(f[5] || 'ordem rejeitada'));
          break;
        }
        case 'DEAL':
          this.onDeal(f[1], num(3), num(4), num(5) * 1000, f[6]);
          break;
      }
    }

    for (const [symbol, list] of this.historyBuffer) {
      list.sort((a, b) => a.time - b.time);
      this.haveHistory.add(symbol);
      this.lastBar.set(symbol, list.at(-1)?.time ?? 0);
      this.emit('history', symbol, list);
    }
    this.historyBuffer.clear();

    if (sawPositions) {
      for (const id of [...this.open.keys()]) if (!seen.has(id)) this.open.delete(id);
    }
    if (!wasConnected) this.emit('status');

    const out: string[] = [];
    for (const symbol of this.symbols) if (!this.haveHistory.has(symbol)) out.push(`HISTORY|${symbol}|${HISTORY_BARS}`);
    for (const p of this.pending.values()) {
      if (p.sent) continue;
      p.sent = true;
      out.push(p.line);
    }
    return out.join('\n');
  }

  private bar(f: string[]): Candle {
    return { time: Number(f[2]), open: Number(f[3]), high: Number(f[4]), low: Number(f[5]), close: Number(f[6]), volume: Number(f[7]) };
  }

  private onDeal(id: string, profit: number, price: number, time: number, why: string): void {
    const p = this.open.get(id);
    if (!p) return;
    this.open.delete(id);
    this.meta.delete(id);
    const risk = Math.abs(p.entryPrice - p.stopLoss);
    const move = p.direction === 'long' ? price - p.entryPrice : p.entryPrice - price;
    const reason: CloseReason = why === 'SL' ? 'sl' : why === 'TP' ? 'tp' : why === 'MANUAL' ? 'manual' : 'broker';
    const trade: ClosedTrade = { ...p, pnl: profit, exitPrice: price, closeTime: time, reason, rMultiple: risk > 0 ? move / risk : 0 };
    this.emit('closed', trade);
  }

  private command(build: (id: string) => string): Promise<{ ticket: string; price: number }> {
    if (!this.connected) return Promise.reject(new Error('Expert Advisor desligado'));
    const id = `C${this.nextCmd++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('sem resposta do MetaTrader'));
      }, ORDER_TIMEOUT_MS);
      this.pending.set(id, { line: build(id), sent: false, resolve, reject, timer });
    });
  }

  async placeOrder(req: OrderRequest): Promise<Position> {
    const comment = `MTAI ${req.strategies[0] ?? ''}`.trim().replace(/\|/g, ' ');
    const { ticket, price } = await this.command((id) =>
      `OPEN|${id}|${req.symbol}|${req.direction === 'long' ? 'BUY' : 'SELL'}|${req.lots}|${req.stopLoss}|${req.takeProfit}|${comment}`);
    this.meta.set(ticket, { strategies: req.strategies, note: req.note });
    const pos: Position = {
      id: ticket, symbol: req.symbol, direction: req.direction, lots: req.lots, entryPrice: price,
      stopLoss: req.stopLoss, takeProfit: req.takeProfit, openTime: Date.now(), pnl: 0, strategies: req.strategies, note: req.note,
    };
    this.open.set(ticket, pos);
    return { ...pos };
  }

  async closePosition(id: string, _reason: CloseReason): Promise<void> {
    await this.command((cmd) => `CLOSE|${cmd}|${id}`);
  }
}
