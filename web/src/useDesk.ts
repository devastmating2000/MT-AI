import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentMessage, AppState, Candle, RiskSettings, ServerEvent } from '../../shared/types';
import { accessToken, api, sessionRejected, socketUrl } from './auth';

export type BarListener = (symbol: string, candle: Candle, closed: boolean) => void;

const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });

/** Live connection to the agent server: state snapshots, the agent conversation and price bars. */
export function useDesk(enabled = true) {
  const [state, setState] = useState<AppState | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [online, setOnline] = useState(false);
  const listeners = useRef(new Set<BarListener>());

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let stopped = false;

    const connect = () => {
      const ws = new WebSocket(socketUrl());
      socket = ws;
      ws.onopen = () => {
        // The server sends nothing until it has seen a valid token.
        ws.send(JSON.stringify({ token: accessToken() }));
        setOnline(true);
        api('/api/messages').then((r) => (r.ok ? r.json() : [])).then((m: AgentMessage[]) => setMessages(m)).catch(() => {});
      };
      socket.onmessage = (e) => {
        const event = JSON.parse(e.data) as ServerEvent;
        if (event.type === 'state') setState(event.state);
        else if (event.type === 'message') {
          setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev.slice(-299), event.message]));
        } else for (const fn of listeners.current) fn(event.symbol, event.candle, event.closed);
      };
      socket.onclose = (e) => {
        setOnline(false);
        if (e.code === 4401) { sessionRejected(); return; } // back to the login screen
        if (!stopped) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [enabled]);

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
