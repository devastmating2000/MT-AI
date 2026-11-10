import type { AgentId, AgentInfo, AgentMessage, MessageKind } from '../shared/types';

export interface Outgoing {
  from: AgentId;
  to: AgentId | 'all';
  topic: string;
  kind?: MessageKind;
  text: string;
  symbol?: string;
  data?: unknown;
  /** Deliver to subscribers without recording it in the visible conversation. */
  silent?: boolean;
}

export interface Reply<R> {
  text: string;
  data: R;
  kind?: MessageKind;
}

type Listener = (data: any, msg: Outgoing) => void | Promise<void>;
type Handler = (data: any) => Reply<any> | Promise<Reply<any>>;

const ROSTER: Array<Pick<AgentInfo, 'id' | 'name' | 'role'>> = [
  { id: 'market', name: 'Dados de mercado', role: 'Recebe cotações e fecha as velas' },
  { id: 'technical', name: 'Analista técnico', role: 'Corre as estratégias em cada vela' },
  { id: 'news', name: 'Analista de notícias', role: 'Calendário económico e sentimento' },
  { id: 'strategist', name: 'Estratega', role: 'Testa as estratégias e atribui pesos' },
  { id: 'coordinator', name: 'Coordenador', role: 'Pesa os votos e decide' },
  { id: 'risk', name: 'Gestor de risco', role: 'Dimensiona e pode vetar' },
  { id: 'execution', name: 'Execução', role: 'Envia as ordens ao corretor' },
];

/**
 * The agents never call each other directly. They publish to topics and ask each other
 * questions through this bus, which records the conversation for the dashboard.
 */
export class MessageBus {
  private readonly listeners = new Map<string, Listener[]>();
  private readonly handlers = new Map<string, Handler>();
  private readonly log: AgentMessage[] = [];
  private readonly agents = new Map<AgentId, AgentInfo>();
  private nextId = 1;
  onMessage: (msg: AgentMessage) => void = () => {};

  constructor(private readonly clock: () => number = Date.now) {
    for (const a of ROSTER) {
      this.agents.set(a.id, { ...a, status: 'idle', lastNote: 'À espera de dados', lastActivity: 0, messages: 0 });
    }
  }

  on(topic: string, listener: Listener): void {
    const list = this.listeners.get(topic) ?? [];
    list.push(listener);
    this.listeners.set(topic, list);
  }

  publish(out: Outgoing): void {
    if (!out.silent) this.record(out);
    for (const listener of this.listeners.get(out.topic) ?? []) {
      try {
        const r = listener(out.data, out);
        if (r instanceof Promise) r.catch((err) => this.fail(out.topic, err));
      } catch (err) {
        this.fail(out.topic, err);
      }
    }
  }

  /** Register the agent that answers questions on a topic. */
  handle(agent: AgentId, topic: string, handler: Handler): void {
    this.handlers.set(`${agent}:${topic}`, handler);
  }

  /** Ask another agent a question; both the question and the answer are recorded. */
  async request<R>(from: AgentId, to: AgentId, topic: string, text: string, data?: unknown, symbol?: string): Promise<R> {
    const handler = this.handlers.get(`${to}:${topic}`);
    if (!handler) throw new Error(`Nenhum agente responde a ${to}:${topic}`);
    this.record({ from, to, topic, kind: 'request', text, symbol });
    const reply = await handler(data);
    this.record({ from: to, to: from, topic, kind: reply.kind ?? 'reply', text: reply.text, symbol });
    return reply.data as R;
  }

  private record(out: Outgoing): void {
    const msg: AgentMessage = {
      id: this.nextId++, time: this.clock(), from: out.from, to: out.to, topic: out.topic,
      kind: out.kind ?? 'info', text: out.text, symbol: out.symbol,
    };
    this.log.push(msg);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    const agent = this.agents.get(out.from);
    if (agent) {
      agent.lastNote = out.text;
      agent.lastActivity = Date.now();
      agent.messages++;
    }
    this.onMessage(msg);
  }

  private fail(topic: string, err: unknown): void {
    console.error(`[bus] erro em ${topic}:`, err);
  }

  history(): AgentMessage[] {
    return this.log.slice();
  }

  roster(): AgentInfo[] {
    const now = Date.now();
    return [...this.agents.values()].map((a) => ({ ...a, status: now - a.lastActivity < 2500 ? 'working' : 'idle' }));
  }
}
