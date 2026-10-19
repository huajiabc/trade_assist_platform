import type { PriceFormatCustom } from 'lightweight-charts';
import type { Candle } from '../../shared/market';
import { formatPrice } from '../../shared/format';

function decimalPlaces(value: number): number {
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e');
  return Math.max(0, (coefficient.split('.')[1]?.length ?? 0) - Number(exponent));
}

/**
 * LWC uses an absolute epsilon when finding ticks. Normalize tiny instruments
 * for rendering only, then format labels back into their original price unit.
 * A single multiplier is applied to candles, structures and crosshair prices.
 */
export function createChartPriceScale(candles: readonly Candle[]): {
  multiplier: number;
  format: PriceFormatCustom;
} {
  const prices = candles.flatMap((candle) => [candle.open, candle.high, candle.low, candle.close]);
  const maximum = Math.max(0, ...prices);
  const exponent = maximum > 0 && maximum < 0.0001 ? Math.min(290, -Math.floor(Math.log10(maximum))) : 0;
  const multiplier = 10 ** exponent;
  const precision = Math.min(12, Math.max(2, ...prices.map((value) => decimalPlaces(value * multiplier))));
  return {
    multiplier,
    format: {
      type: 'custom',
      formatter: (value) => formatPrice(value / multiplier, false),
      minMove: 10 ** -precision,
      base: 10 ** precision,
    },
  };
}
