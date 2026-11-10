// The whole desk (simulated broker and all agents) running inside the browser tab.
// Used when no agent server is reachable, so the interface can still be explored.
import type { RiskSettings, ServerEvent } from '../../shared/types';
import { PaperBroker } from '../../server/broker/paper';
import { Desk } from '../../server/desk';
import { specFor } from '../../server/symbols';

const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD'];

export function startLocalDesk(onEvent: (event: ServerEvent) => void) {
  const broker = new PaperBroker(SYMBOLS.map(specFor), { balance: 10_000, candleMs: 2000, seed: 20260, timeframeSec: 900 });
  const desk = new Desk(broker, { mode: 'paper', symbols: SYMBOLS, tradingEnabled: true });
  desk.onEvent = onEvent;
  void broker.start();
  const timer = window.setInterval(() => onEvent({ type: 'state', state: desk.state() }), 1000);
  onEvent({ type: 'state', state: desk.state() });
  return {
    messages: () => desk.bus.history(),
    candles: (symbol: string) => desk.candles(symbol),
    setTrading: (enabled: boolean) => desk.setTrading(enabled),
    setRisk: (risk: Partial<RiskSettings>) => desk.setRisk(risk),
    closePosition: (id: string) => broker.closePosition(id, 'manual'),
    stop: () => { window.clearInterval(timer); broker.stop(); },
  };
}

export type LocalDesk = ReturnType<typeof startLocalDesk>;
