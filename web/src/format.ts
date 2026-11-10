import type { Direction, SymbolSpec } from '../../shared/types';

export const num = (v: number, digits = 2) =>
  v.toLocaleString('pt-PT', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: 'always' } as Intl.NumberFormatOptions);

export const signed = (v: number, digits = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), digits)}`;

export const pct = (v: number, digits = 0) => `${num(v * 100, digits)}%`;

export const price = (v: number, spec?: SymbolSpec) => (Number.isFinite(v) ? v.toFixed(spec?.digits ?? 5) : '—');

export const sideLabel = (d: Direction) => (d === 'long' ? 'Compra' : 'Venda');

export const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

const clock = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' });
const day = new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' });

export const hhmm = (ms: number) => clock.format(ms);
export const dayTime = (ms: number) => day.format(ms);
