import type { SymbolSpec } from '../shared/types';

const SPECS: SymbolSpec[] = [
  { symbol: 'EURUSD', label: 'Euro / Dólar', kind: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, base: 'EUR', quote: 'USD', spreadPips: 0.9, minLot: 0.01, lotStep: 0.01 },
  { symbol: 'GBPUSD', label: 'Libra / Dólar', kind: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, base: 'GBP', quote: 'USD', spreadPips: 1.2, minLot: 0.01, lotStep: 0.01 },
  { symbol: 'USDJPY', label: 'Dólar / Iene', kind: 'forex', digits: 3, pip: 0.01, contractSize: 100_000, base: 'USD', quote: 'JPY', spreadPips: 1.1, minLot: 0.01, lotStep: 0.01 },
  { symbol: 'AUDUSD', label: 'Dólar australiano / Dólar', kind: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, base: 'AUD', quote: 'USD', spreadPips: 1.0, minLot: 0.01, lotStep: 0.01 },
  { symbol: 'USDCHF', label: 'Dólar / Franco suíço', kind: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, base: 'USD', quote: 'CHF', spreadPips: 1.3, minLot: 0.01, lotStep: 0.01 },
  { symbol: 'XAUUSD', label: 'Ouro', kind: 'metal', digits: 2, pip: 0.1, contractSize: 100, base: 'XAU', quote: 'USD', spreadPips: 2.5, minLot: 0.01, lotStep: 0.01 },
  { symbol: 'XAGUSD', label: 'Prata', kind: 'metal', digits: 3, pip: 0.01, contractSize: 5_000, base: 'XAG', quote: 'USD', spreadPips: 2.5, minLot: 0.01, lotStep: 0.01 },
];

export function specFor(symbol: string): SymbolSpec {
  const known = SPECS.find((s) => s.symbol === symbol);
  if (known) return { ...known };
  // Unknown symbol: assume a 5-digit USD-quoted FX pair until the broker reports real specs.
  return {
    symbol, label: symbol, kind: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000,
    base: symbol.slice(0, 3), quote: symbol.slice(3, 6) || 'USD', spreadPips: 1.5, minLot: 0.01, lotStep: 0.01,
  };
}

/**
 * Account-currency (USD) value of a 1.0 price move on one lot.
 * `usdPerQuote` converts the quote currency to USD (1 for USD-quoted symbols).
 */
export function valuePerPrice(spec: SymbolSpec, price: number): number {
  if (spec.valuePerPrice) return spec.valuePerPrice;
  if (spec.quote === 'USD') return spec.contractSize;
  // USD-based pairs (USDJPY, USDCHF): quote currency converts through the pair's own price.
  if (spec.base === 'USD' && price > 0) return spec.contractSize / price;
  return spec.contractSize;
}

export function roundPrice(spec: SymbolSpec, price: number): number {
  const f = 10 ** spec.digits;
  return Math.round(price * f) / f;
}
