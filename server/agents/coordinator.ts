import { z } from 'zod';
import { STRATEGY_LABELS, type Direction, type NewsBrief, type Position, type StrategySignal, type StrategyStats } from '../../shared/types';
import type { OrderRequest } from '../broker/types';
import { askStructured, llmAvailable } from '../llm/client';
import { fmt, side, type DeskContext } from './context';
import type { Proposal, RiskVerdict } from './risk';

const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'reduce', 'veto']),
  sizeFactor: z.number().describe('Fraction of the normal position size to take, between 0.25 and 1. Use 1 for approve.'),
  reasoning: z.string().describe('At most two sentences in European Portuguese'),
});

const SYSTEM = `You are the coordinator of a multi-agent foreign-exchange and precious-metals trading desk.
Specialist agents have already done the quantitative work: strategies voted, a strategist weighted each vote by its backtested record on this symbol, and a news analyst checked the calendar.
You are the final judgement before the risk manager. Review the proposed trade and decide:
- approve: the evidence is coherent and nothing argues against it.
- reduce: the trade is reasonable but something weakens it (thin sample, conflicting votes, news leaning the other way, correlated open positions). Give a sizeFactor below 1.
- veto: the evidence is contradictory or the context makes the trade unwise.
You can only shrink or block a trade, never enlarge it. The risk manager enforces the account limits after you; do not redo its arithmetic.
Be decisive and brief. Backtest statistics describe the past and small samples are weak evidence.`;

const sgn = (d: Direction) => (d === 'long' ? 1 : -1);

/**
 * Collects the technical votes, weights them with the strategist's record, checks the news,
 * optionally asks the language model for a second opinion, and walks an agreed trade through
 * risk and execution.
 */
export function startCoordinator(ctx: DeskContext): void {
  const { bus, broker } = ctx;
  const busy = new Set<string>();

  function note(symbol: string, direction: Direction | null, score: number, outcome: string): void {
    ctx.consensus.set(symbol, { symbol, direction, score, time: broker.now(), outcome });
  }

  /**
   * `event` marks a trade on the reaction to a data release. Those come from the event
   * specialist with their own record, are exempt from the news blackout (the release is the
   * reason for the trade) and always start at half size.
   */
  async function decide(symbol: string, signals: StrategySignal[], event?: { stat: StrategyStats; title: string }): Promise<void> {
    if (broker.positions().some((p) => p.symbol === symbol)) return;

    const stats = event ? [event.stat] : await bus.request<StrategyStats[]>('coordinator', 'strategist', 'strategy.weights',
      `Que peso tem cada estratégia em ${symbol}?`, { symbol }, symbol);
    const votes = signals
      .map((s) => ({ s, stat: stats.find((x) => x.strategy === s.strategy) }))
      .filter((v) => v.stat && !v.stat.benched) as Array<{ s: StrategySignal; stat: StrategyStats }>;
    if (!votes.length) {
      note(symbol, null, 0, 'Sinais só de estratégias no banco');
      bus.publish({ from: 'coordinator', to: 'all', topic: 'coordinator.pass', symbol,
        text: `${symbol}: ignoro. Os sinais vêm de estratégias sem resultados positivos neste símbolo` });
      return;
    }

    const tally = { long: 0, short: 0 };
    for (const v of votes) tally[v.s.direction] += v.stat.weight * v.s.confidence;
    const direction: Direction = tally.long >= tally.short ? 'long' : 'short';
    const net = Math.abs(tally.long - tally.short);

    const brief: NewsBrief = event ? { symbol, blackout: false, reason: '', bias: 0 } : await bus.request<NewsBrief>('coordinator', 'news', 'news.brief',
      `Há notícias que impeçam uma ${side(direction)} em ${symbol}?`, { symbol }, symbol);
    if (brief.blackout) {
      note(symbol, direction, net, 'Bloqueado por notícia de alto impacto');
      return;
    }

    const score = Math.min(1, Math.max(0, net + 0.15 * brief.bias * sgn(direction)));
    if (score < ctx.risk.minConsensus) {
      note(symbol, direction, score, 'Consenso insuficiente');
      bus.publish({ from: 'coordinator', to: 'all', topic: 'coordinator.pass', symbol,
        text: `${symbol}: consenso de ${fmt(score)} para ${side(direction)}, abaixo do mínimo de ${fmt(ctx.risk.minConsensus)}. Fico de fora` });
      return;
    }

    const agreeing = votes.filter((v) => v.s.direction === direction).sort((a, b) => b.stat.weight * b.s.confidence - a.stat.weight * a.s.confidence);
    const lead = agreeing[0].s;
    const proposal: Proposal = {
      symbol, direction, stopLoss: lead.stopLoss, takeProfit: lead.takeProfit,
      strategies: agreeing.map((v) => v.s.strategy), score, sizeFactor: event ? 0.5 : 1,
    };

    let reasoning = `${agreeing.map((v) => STRATEGY_LABELS[v.s.strategy]).join(' + ')}, consenso ${fmt(score)}`;
    if (event) reasoning = `Reação a ${event.title}. ${lead.rationale}`;
    if (llmAvailable()) {
      const review = await askStructured(ReviewSchema, SYSTEM, JSON.stringify({
        proposal: { symbol, direction, entry: lead.entry, stopLoss: lead.stopLoss, takeProfit: lead.takeProfit, consensusScore: score },
        votes: votes.map((v) => ({
          strategy: v.s.strategy, direction: v.s.direction, confidence: v.s.confidence, rationale: v.s.rationale,
          record: { trades: v.stat.trades, winRate: v.stat.winRate, profitFactor: v.stat.profitFactor, expectancyR: v.stat.expectancyR, liveTrades: v.stat.liveTrades, liveWins: v.stat.liveWins },
        })),
        news: { biasForLong: brief.bias },
        dataRelease: event ? { title: event.title, note: 'Trade on the confirmed reaction to this release; spreads and slippage are worse than usual.' } : null,
        openPositions: broker.positions().map((p) => ({ symbol: p.symbol, direction: p.direction })),
        statisticsSource: ctx.mode === 'paper' ? 'synthetic simulated data' : 'broker history',
      }));
      if (review) {
        reasoning = review.reasoning.slice(0, 300);
        if (review.verdict === 'veto') {
          note(symbol, direction, score, 'Vetado pelo coordenador');
          bus.publish({ from: 'coordinator', to: 'all', topic: 'coordinator.veto', kind: 'warn', symbol, text: `${symbol}: veto. ${reasoning}` });
          return;
        }
        if (review.verdict === 'reduce') proposal.sizeFactor *= Math.min(1, Math.max(0.25, review.sizeFactor));
      }
    }

    bus.publish({ from: 'coordinator', to: 'risk', topic: 'coordinator.proposal', kind: 'decision', symbol,
      text: `${symbol}: proponho ${side(direction)}${proposal.sizeFactor < 1 ? ` com ${fmt(proposal.sizeFactor * 100, 0)}% do tamanho` : ''}. ${reasoning}` });

    const verdict = await bus.request<RiskVerdict>('coordinator', 'risk', 'risk.review',
      `Podes aprovar e dimensionar esta ${side(direction)} em ${symbol}?`, proposal, symbol);
    if (!verdict.approved) {
      note(symbol, direction, score, `Rejeitado pelo risco: ${verdict.reason}`);
      return;
    }
    try {
      await execute(proposal, verdict, reasoning);
    } finally {
      // The approval reserved a slot with the risk manager; hand it back once the order is settled.
      bus.publish({ from: 'coordinator', to: 'risk', topic: 'risk.release', data: { symbol }, text: '', silent: true });
    }
  }

  async function execute(proposal: Proposal, verdict: RiskVerdict, reasoning: string): Promise<void> {
    const { symbol, direction, score } = proposal;
    if (!ctx.tradingEnabled) {
      note(symbol, direction, score, 'Aprovado, mas a negociação está em pausa');
      bus.publish({ from: 'coordinator', to: 'all', topic: 'coordinator.shadow', symbol,
        text: `${symbol}: ${side(direction)} aprovada, mas a negociação está em pausa. Ordem não enviada` });
      return;
    }

    const order: OrderRequest = {
      symbol, direction, lots: verdict.lots, stopLoss: proposal.stopLoss, takeProfit: proposal.takeProfit,
      strategies: proposal.strategies, note: reasoning,
    };
    const position = await bus.request<Position | null>('coordinator', 'execution', 'execution.order',
      `Executa ${side(direction)} de ${fmt(verdict.lots)} lotes em ${symbol}`, order, symbol);
    note(symbol, direction, score, position ? 'Ordem executada' : 'Ordem recusada pelo corretor');
  }

  type Incoming = { symbol: string; signals: StrategySignal[]; event?: { stat: StrategyStats; title: string } };
  const onSignals = async ({ symbol, signals, event }: Incoming) => {
    // One decision at a time per symbol; a slow model reply must not stack up proposals.
    if (busy.has(symbol)) return;
    busy.add(symbol);
    try {
      await decide(symbol, signals, event);
    } finally {
      busy.delete(symbol);
    }
  };
  bus.on('analysis.signals', onSignals);
  bus.on('event.signals', onSignals);
}
