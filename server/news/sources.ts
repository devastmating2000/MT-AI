import type { Headline, NewsEvent } from '../../shared/types';
import { mulberry32 } from '../broker/simMarket';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CHF', 'CAD', 'NZD', 'CNY'];

/** Economic calendar for the current week (public Forex Factory export). */
export async function fetchCalendar(): Promise<NewsEvent[]> {
  const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`calendário respondeu ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, string>>;
  const out: NewsEvent[] = [];
  for (const row of rows) {
    const time = Date.parse(row.date ?? '');
    const impact = (row.impact ?? '').toLowerCase();
    if (!Number.isFinite(time) || !CURRENCIES.includes(row.country ?? '')) continue;
    if (impact !== 'high' && impact !== 'medium' && impact !== 'low') continue;
    out.push({
      id: `${row.country}-${time}-${row.title}`, time, currency: row.country, title: String(row.title ?? '').slice(0, 120),
      impact, forecast: row.forecast || undefined, previous: row.previous || undefined,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

function decode(s: string): string {
  return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

export async function fetchHeadlines(feeds: string[]): Promise<Headline[]> {
  const out: Headline[] = [];
  await Promise.all(feeds.map(async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;
      const xml = await res.text();
      const host = new URL(url).hostname.replace(/^www\./, '');
      for (const item of xml.match(/<item[\s\S]*?<\/item>/g) ?? []) {
        const title = decode(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
        const time = Date.parse(decode(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? ''));
        if (title) out.push({ id: `${host}-${title}`, title: title.slice(0, 200), time: Number.isFinite(time) ? time : Date.now(), source: host });
      }
    } catch {
      // One dead feed must not take the others down.
    }
  }));
  return out.sort((a, b) => b.time - a.time).slice(0, 40);
}

const MENTIONS: Record<string, RegExp> = {
  USD: /\b(usd|dollar|fed|fomc|powell|treasur|nonfarm|payrolls)\b/i,
  EUR: /\b(eur|euro|ecb|eurozone|lagarde)\b/i,
  GBP: /\b(gbp|pound|sterling|boe|bank of england)\b/i,
  JPY: /\b(jpy|yen|boj|bank of japan)\b/i,
  AUD: /\b(aud|aussie|rba)\b/i,
  CHF: /\b(chf|franc|snb)\b/i,
  XAU: /\b(xau|gold|bullion)\b/i,
  XAG: /\b(xag|silver)\b/i,
};
const UP = /\b(rises?|gains?|surges?|rall(y|ies)|jumps?|climbs?|strengthens?|hawkish|beats?|higher|rebounds?|soars?|advances?)\b/i;
const DOWN = /\b(falls?|drops?|slumps?|slides?|tumbles?|plunges?|weakens?|dovish|misses|lower|retreats?|sinks?|declines?)\b/i;

/** Keyword fallback used when no language model is configured. Crude by design. */
export function lexiconSentiment(headlines: Headline[]): Record<string, number> {
  const sum: Record<string, number> = {};
  const count: Record<string, number> = {};
  for (const h of headlines) {
    const tone = (UP.test(h.title) ? 1 : 0) - (DOWN.test(h.title) ? 1 : 0);
    for (const [ccy, re] of Object.entries(MENTIONS)) {
      if (!re.test(h.title)) continue;
      sum[ccy] = (sum[ccy] ?? 0) + tone;
      count[ccy] = (count[ccy] ?? 0) + 1;
    }
  }
  const out: Record<string, number> = {};
  for (const ccy of Object.keys(count)) out[ccy] = Math.max(-1, Math.min(1, sum[ccy] / Math.max(3, count[ccy])));
  return out;
}

const TEMPLATES: Array<{ hour: number; minute: number; currency: string; title: string; impact: NewsEvent['impact'] }> = [
  { hour: 7, minute: 0, currency: 'GBP', title: 'PIB do Reino Unido (simulado)', impact: 'high' },
  { hour: 9, minute: 0, currency: 'EUR', title: 'IPC da Zona Euro (simulado)', impact: 'high' },
  { hour: 13, minute: 30, currency: 'USD', title: 'Emprego não agrícola dos EUA (simulado)', impact: 'high' },
  { hour: 13, minute: 30, currency: 'USD', title: 'IPC dos EUA (simulado)', impact: 'high' },
  { hour: 14, minute: 0, currency: 'USD', title: 'ISM Indústria (simulado)', impact: 'medium' },
  { hour: 18, minute: 0, currency: 'USD', title: 'Decisão de taxas da Fed (simulado)', impact: 'high' },
  { hour: 23, minute: 30, currency: 'JPY', title: 'IPC de Tóquio (simulado)', impact: 'medium' },
  { hour: 8, minute: 30, currency: 'EUR', title: 'PMI da Alemanha (simulado)', impact: 'medium' },
];

/** Deterministic made-up calendar for paper mode, so the news blackout logic has something to react to. */
export function simulatedEvents(fromMs: number, days: number): NewsEvent[] {
  const out: NewsEvent[] = [];
  const firstDay = Math.floor(fromMs / 86_400_000);
  for (let d = firstDay; d < firstDay + days; d++) {
    const rand = mulberry32(d * 2654435761);
    for (const t of TEMPLATES) {
      if (rand() > 0.4) continue;
      const time = d * 86_400_000 + t.hour * 3_600_000 + t.minute * 60_000;
      out.push({ id: `sim-${d}-${t.title}`, time, currency: t.currency, title: t.title, impact: t.impact });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}
