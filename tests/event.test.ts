import { describe, expect, it } from 'vitest';
import type { AgentMessage, Candle } from '../shared/types';
import { readReaction } from '../server/agents/event';
import { PaperBroker } from '../server/broker/paper';
import { Desk } from '../server/desk';
import { specFor } from '../server/symbols';

const quiet = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ time: i * 900, open: 1, high: 1.0005, low: 0.9995, close: 1, volume: 1 }));
const bar = (o: number, h: number, l: number, c: number): Candle => ({ time: 99 * 900, open: o, high: h, low: l, close: c, volume: 1 });

describe('release-bar reading', () => {
  it('accepts a large one-sided bar and reports its size', () => {
    const r = readReaction([...quiet(60), bar(1, 1.0052, 0.9998, 1.005)]);
    expect(r?.direction).toBe('long');
    expect(r!.ratio).toBeCloseTo(5.4, 1);
  });

  it('ignores an ordinary bar', () => {
    expect(readReaction([...quiet(60), bar(1, 1.0008, 0.9996, 1.0007)])).toBeNull();
  });

  it('ignores a whipsaw that spiked and closed back in the middle', () => {
    expect(readReaction([...quiet(60), bar(1, 1.006, 0.996, 1.0005)])).toBeNull();
  });
});

describe('event specialist on the desk', () => {
  it('announces a plan, trades the confirmed reaction at half size and is not stopped by the news blackout', async () => {
    const symbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'];
    const broker = new PaperBroker(symbols.map(specFor), { balance: 10_000, candleMs: 1000, seed: 11, timeframeSec: 900, historyBars: 1200 });
    const desk = new Desk(broker, { mode: 'paper', symbols, tradingEnabled: true });
    const messages: AgentMessage[] = [];
    desk.onEvent = (e) => { if (e.type === 'message') messages.push(e.message); };
    broker.seed(Date.UTC(2026, 2, 2) / 1000);

    const traded = () => [...broker.positions(), ...desk.state().trades].some((t) => t.strategies.includes('news_impulse'));
    for (let i = 0; i < 3000 && !traded(); i++) {
      broker.stepCandle();
      await new Promise((r) => setImmediate(r));
    }
    expect(traded()).toBe(true);
    expect(messages.some((m) => m.from === 'event' && m.topic === 'event.plan')).toBe(true);

    // The proposal that followed the specialist's signal carried the half-size rule...
    const signal = messages.findIndex((m) => m.topic === 'event.signals');
    const after = messages.slice(signal);
    expect(after.find((m) => m.topic === 'coordinator.proposal')!.text).toContain('50% do tamanho');
    // ...the coordinator did not ask the news analyst for clearance...
    const approval = after.findIndex((m) => m.from === 'risk' && m.text.startsWith('Aprovado'));
    expect(after.slice(0, approval).some((m) => m.topic === 'news.brief')).toBe(false);
    // ...and the risk manager sized it at about half of the usual 0.5%.
    const pctOfCapital = Number(/\(([\d,]+)% do capital\)/.exec(after[approval].text)![1].replace(',', '.'));
    expect(pctOfCapital).toBeGreaterThan(0.1);
    expect(pctOfCapital).toBeLessThanOrEqual(0.26);
  });
});
