import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentMessage, AppState, Candle, RiskSettings, ServerEvent } from '../../shared/types';

export type BarListener = (symbol: string, candle: Candle, closed: boolean) => void;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Live connection to the agent server: state snapshots, the agent conversation and price bars. */
export function useDesk() {
  const [state, setState] = useState<AppState | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [online, setOnline] = useState(false);
  const listeners = useRef(new Set<BarListener>());

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let stopped = false;

    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      socket.onopen = () => {
        setOnline(true);
        fetch('/api/messages').then((r) => r.json()).then((m: AgentMessage[]) => setMessages(m)).catch(() => {});
      };
      socket.onmessage = (e) => {
        const event = JSON.parse(e.data) as ServerEvent;
        if (event.type === 'state') setState(event.state);
        else if (event.type === 'message') {
          setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev.slice(-299), event.message]));
        } else for (const fn of listeners.current) fn(event.symbol, event.candle, event.closed);
      };
      socket.onclose = () => {
        setOnline(false);
        if (!stopped) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  const subscribeBars = useCallback((fn: BarListener) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  const setTrading = useCallback((enabled: boolean) => post('/api/trading', { enabled }), []);
  const saveRisk = useCallback((risk: Partial<RiskSettings>) => post('/api/risk', risk), []);
  const closePosition = useCallback((id: string) => post(`/api/positions/${encodeURIComponent(id)}/close`, {}), []);

  return { state, messages, online, subscribeBars, setTrading, saveRisk, closePosition };
}

export type DeskApi = ReturnType<typeof useDesk>;
