import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentMessage, AppState, Candle, RiskSettings, ServerEvent } from '../../shared/types';
import { accessToken, api, sessionRejected, socketUrl } from './auth';
import type { LocalDesk } from './localDesk';

export type BarListener = (symbol: string, candle: Candle, closed: boolean) => void;

const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });

/**
 * The desk's data and controls. Normally a live connection to the agent server; with
 * `local` set, the simulator and agents run inside this tab instead.
 */
export function useDesk(enabled = true, local = false) {
  const [state, setState] = useState<AppState | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [online, setOnline] = useState(false);
  const listeners = useRef(new Set<BarListener>());
  const localDesk = useRef<LocalDesk | null>(null);

  const handle = useCallback((event: ServerEvent) => {
    if (event.type === 'state') setState(event.state);
    else if (event.type === 'message') {
      setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev.slice(-299), event.message]));
    } else for (const fn of listeners.current) fn(event.symbol, event.candle, event.closed);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setState(null);
    setMessages([]);
    let stopped = false;

    if (local) {
      import('./localDesk').then(({ startLocalDesk }) => {
        if (stopped) return;
        localDesk.current = startLocalDesk(handle);
        setMessages(localDesk.current.messages());
        setOnline(true);
      });
      return () => {
        stopped = true;
        localDesk.current?.stop();
        localDesk.current = null;
      };
    }

    let socket: WebSocket | null = null;
    let retry: number | undefined;
    const connect = () => {
      const ws = new WebSocket(socketUrl());
      socket = ws;
      ws.onopen = () => {
        // The server sends nothing until it has seen a valid token.
        ws.send(JSON.stringify({ token: accessToken() }));
        setOnline(true);
        api('/api/messages').then((r) => (r.ok ? r.json() : [])).then((m: AgentMessage[]) => setMessages(m)).catch(() => {});
      };
      ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerEvent);
      ws.onclose = (e) => {
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
  }, [enabled, local, handle]);

  const subscribeBars = useCallback((fn: BarListener) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  const done = { ok: true };
  const setTrading = useCallback(async (on: boolean) => {
    if (localDesk.current) { localDesk.current.setTrading(on); return done; }
    return post('/api/trading', { enabled: on });
  }, []);
  const saveRisk = useCallback(async (risk: Partial<RiskSettings>) => {
    if (localDesk.current) { localDesk.current.setRisk(risk); return done; }
    return post('/api/risk', risk);
  }, []);
  const closePosition = useCallback(async (id: string) => {
    if (localDesk.current) { await localDesk.current.closePosition(id).catch(() => {}); return done; }
    return post(`/api/positions/${encodeURIComponent(id)}/close`, {});
  }, []);
  const loadCandles = useCallback(async (symbol: string): Promise<Candle[]> => {
    if (localDesk.current) return localDesk.current.candles(symbol);
    const res = await api(`/api/candles?symbol=${symbol}`);
    return res.ok ? res.json() : [];
  }, []);

  return { state, messages, online, subscribeBars, loadCandles, setTrading, saveRisk, closePosition };
}

export type DeskApi = ReturnType<typeof useDesk>;
