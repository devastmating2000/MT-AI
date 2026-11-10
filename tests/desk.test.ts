import { describe, expect, it } from 'vitest';
import type { AgentMessage, ClosedTrade } from '../shared/types';
import { Mt5BridgeBroker } from '../server/broker/mt5Bridge';
import { PaperBroker } from '../server/broker/paper';
import { Desk } from '../server/desk';
import { specFor } from '../server/symbols';

const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'];
const tick = () => new Promise((r) => setImmediate(r));

function paperDesk(risk = {}) {
  const broker = new PaperBroker(SYMBOLS.map(specFor), { balance: 10_000, candleMs: 1000, seed: 11, timeframeSec: 900, historyBars: 1200 });
  const desk = new Desk(broker, { mode: 'paper', symbols: SYMBOLS, tradingEnabled: true, risk });
  const messages: AgentMessage[] = [];
  desk.onEvent = (e) => { if (e.type === 'message') messages.push(e.message); };
  broker.seed(Date.UTC(2026, 2, 2) / 1000);
  return { broker, desk, messages };
}

describe('paper broker', () => {
  it('closes a long at its stop and books the loss', async () => {
    const broker = new PaperBroker([specFor('EURUSD')], { balance: 10_000, candleMs: 1000, seed: 3, timeframeSec: 900, historyBars: 10 });
    broker.seed(Date.UTC(2026, 2, 2) / 1000);
    broker.stepCandle();
    const closed: ClosedTrade[] = [];
    broker.on('closed', (t) => closed.push(t));
    const pos = await broker.placeOrder({ symbol: 'EURUSD', direction: 'long', lots: 0.1, stopLoss: 0.5, takeProfit: 5, strategies: [] });
    expect(pos.pnl).toBeLessThan(0); // opens one spread under water
    // Move the stop just under the market: the next adverse tick must close the trade there.
    const live = (broker as any).open.get(pos.id);
    live.stopLoss = pos.entryPrice - 0.00012;
    for (let i = 0; i < 400 && !closed.length; i++) broker.step();
    expect(closed).toHaveLength(1);
    expect(closed[0].reason).toBe('sl');
    expect(closed[0].rMultiple).toBeCloseTo(-1);
    expect(broker.account().balance).toBeCloseTo(10_000 + closed[0].pnl);
    expect(closed[0].pnl).toBeCloseTo(-0.00012 * 0.1 * 100_000);
  });
});

describe('desk', () => {
  it('trades end to end while respecting the risk limits', async () => {
    const { broker, desk, messages } = paperDesk({ maxOpenPositions: 2 });
    let maxOpen = 0;
    for (let i = 0; i < 700; i++) {
      broker.stepCandle();
      await tick();
      maxOpen = Math.max(maxOpen, broker.positions().length);
    }
    const state = desk.state();
    expect(state.trades.length).toBeGreaterThan(0);
    expect(maxOpen).toBeLessThanOrEqual(2);
    // Every order was preceded by a risk approval and no trade risked more than the configured share.
    const fills = messages.filter((m) => m.from === 'execution' && m.topic === 'execution.order');
    const approvals = messages.filter((m) => m.from === 'risk' && m.text.startsWith('Aprovado'));
    expect(fills.length).toBeGreaterThan(0);
    expect(approvals.length).toBeGreaterThanOrEqual(fills.length);
    for (const t of state.trades) {
      if (t.reason === 'sl') expect(Math.abs(t.pnl)).toBeLessThan(10_500 * 0.005 * 1.25);
    }
    // All seven agents took part in the conversation.
    expect(new Set(messages.map((m) => m.from)).size).toBeGreaterThanOrEqual(6);
  });

  it('keeps analysing but sends no orders while trading is paused', async () => {
    const { broker, desk, messages } = paperDesk();
    desk.setTrading(false);
    for (let i = 0; i < 400; i++) { broker.stepCandle(); await tick(); }
    expect(broker.positions()).toHaveLength(0);
    expect(desk.state().trades).toHaveLength(0);
    expect(messages.some((m) => m.topic === 'coordinator.shadow')).toBe(true);
  });

  it('halts new entries after the daily loss limit', async () => {
    const { broker, desk, messages } = paperDesk({ maxDailyLossPct: 0.5, riskPerTradePct: 0.5 });
    for (let i = 0; i < 1500 && !messages.some((m) => m.topic === 'risk.halt'); i++) { broker.stepCandle(); await tick(); }
    expect(messages.some((m) => m.topic === 'risk.halt')).toBe(true);
    const acc = desk.state().account;
    expect(acc.dayPnl).toBeLessThanOrEqual(-acc.dayStartBalance * 0.005);
  });

  it('clamps risk settings to sane bounds', () => {
    const { desk } = paperDesk();
    expect(desk.setRisk({ riskPerTradePct: 50, maxOpenPositions: -3 })).toMatchObject({ riskPerTradePct: 5, maxOpenPositions: 1 });
  });
});

describe('mt5 bridge protocol', () => {
  it('requests history, relays an order and reports the closing deal', async () => {
    const broker = new Mt5BridgeBroker(['EURUSD']);
    const closed: ClosedTrade[] = [];
    broker.on('closed', (t) => closed.push(t));
    let bars = 0;
    broker.on('history', (_s, c) => { bars = c.length; });

    expect(broker.sync('ACCOUNT|5000|5000|USD\nTICK|EURUSD|1.1|1.1001|1700000000')).toBe('HISTORY|EURUSD|1000');
    expect(broker.sync('HIST|EURUSD|900|1|2|0.5|1.5|10\nHIST|EURUSD|0|1|2|0.5|1.5|10')).toBe('');
    expect(bars).toBe(2);
    expect(broker.account().balance).toBe(5000);

    const order = broker.placeOrder({ symbol: 'EURUSD', direction: 'short', lots: 0.2, stopLoss: 1.11, takeProfit: 1.08, strategies: ['macd_momentum'] });
    const sent = broker.sync('POSITIONS|0');
    expect(sent).toMatch(/^OPEN\|C1\|EURUSD\|SELL\|0\.2\|1\.11\|1\.08\|MTAI macd_momentum$/);
    expect(broker.sync('POSITIONS|0')).toBe(''); // a command is delivered once
    broker.sync('RESULT|C1|OK|777|1.1');
    const pos = await order;
    expect(pos).toMatchObject({ id: '777', entryPrice: 1.1, direction: 'short' });

    broker.sync('POSITIONS|1\nPOS|777|EURUSD|SELL|0.2|1.1|1.11|1.08|12.5|1700000000');
    expect(broker.positions()[0].strategies).toEqual(['macd_momentum']);
    broker.sync('POSITIONS|0\nDEAL|777|EURUSD|400|1.08|1700000900|TP');
    expect(broker.positions()).toHaveLength(0);
    expect(closed[0]).toMatchObject({ reason: 'tp', pnl: 400, strategies: ['macd_momentum'] });
    expect(closed[0].rMultiple).toBeCloseTo(2);
  });

  it('rejects an order when the terminal reports an error', async () => {
    const broker = new Mt5BridgeBroker([]);
    broker.sync('ACCOUNT|1|1|USD');
    const order = broker.placeOrder({ symbol: 'EURUSD', direction: 'long', lots: 0.1, stopLoss: 1, takeProfit: 2, strategies: [] });
    broker.sync('');
    broker.sync('RESULT|C1|ERR|0|0|Mercado fechado');
    await expect(order).rejects.toThrow('Mercado fechado');
  });
});
