import { CandlestickSeries, createChart, LineStyle, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { Candle, Position, SymbolSpec } from '../../shared/types';
import type { BarListener } from './useDesk';

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const toBar = (c: Candle) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });

interface Props {
  spec: SymbolSpec;
  positions: Position[];
  subscribeBars: (fn: BarListener) => () => void;
  loadCandles: (symbol: string) => Promise<Candle[]>;
}

export function PriceChart({ spec, positions, subscribeBars, loadCandles }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lines = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, { autoSize: true });
    const s = chart.addSeries(CandlestickSeries, {
      borderVisible: false,
      priceFormat: { type: 'price', precision: spec.digits, minMove: 1 / 10 ** spec.digits },
    });
    series.current = s;

    // Colours come from the page tokens so the chart follows the light and dark themes.
    const paint = () => {
      chart.applyOptions({
        layout: { background: { color: token('--surface') }, textColor: token('--ink-3'), fontFamily: token('--mono'), fontSize: 11 },
        grid: { vertLines: { color: token('--line') }, horzLines: { color: token('--line') } },
        timeScale: { borderColor: token('--line-strong'), timeVisible: true, secondsVisible: false, rightOffset: 6 },
        rightPriceScale: { borderColor: token('--line-strong') },
        crosshair: { vertLine: { color: token('--ink-3'), labelBackgroundColor: token('--surface-3') }, horzLine: { color: token('--ink-3'), labelBackgroundColor: token('--surface-3') } },
      });
      s.applyOptions({ upColor: token('--up-mark'), downColor: token('--down-mark'), wickUpColor: token('--up-mark'), wickDownColor: token('--down-mark') });
    };
    paint();
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', paint);

    let last = 0;
    let cancelled = false;
    loadCandles(spec.symbol)
      .then((candles: Candle[]) => {
        if (cancelled || !candles.length) return;
        s.setData(candles.map(toBar));
        last = candles[candles.length - 1].time;
        chart.timeScale().setVisibleLogicalRange({ from: candles.length - 140, to: candles.length + 6 });
      })
      .catch(() => {});

    const off = subscribeBars((symbol, candle) => {
      if (symbol !== spec.symbol || !last || candle.time < last) return;
      last = candle.time;
      s.update(toBar(candle));
    });

    return () => {
      cancelled = true;
      off();
      scheme.removeEventListener('change', paint);
      lines.current = [];
      series.current = null;
      chart.remove();
    };
  }, [spec.symbol, spec.digits, subscribeBars, loadCandles]);

  const key = positions.map((p) => `${p.id}:${p.stopLoss}:${p.takeProfit}`).join(',');
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const line of lines.current) s.removePriceLine(line);
    lines.current = positions.flatMap((p) => [
      s.createPriceLine({ price: p.entryPrice, color: token('--accent'), lineWidth: 1, lineStyle: LineStyle.Solid, title: p.direction === 'long' ? 'compra' : 'venda' }),
      s.createPriceLine({ price: p.stopLoss, color: token('--down-mark'), lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'stop' }),
      s.createPriceLine({ price: p.takeProfit, color: token('--up-mark'), lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'alvo' }),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, spec.symbol]);

  return <div ref={host} className="chart" role="img" aria-label={`Gráfico de velas de 15 minutos de ${spec.symbol}`} />;
}
