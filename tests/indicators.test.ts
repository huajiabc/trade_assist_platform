import { describe, expect, it } from 'vitest';
import { detectRuleIndicators, RULE_INDICATOR_PARAMETERS, type RuleIndicatorZone } from '../shared/indicators';
import type { Candle } from '../shared/market';

const START = 1_700_000_000;
const candle = (index: number, open: number, high: number, low: number, close: number): Candle => ({
  timestamp: START + index * 300, open, high, low, close, volume: 1,
});
const bullGap = (): Candle[] => [
  candle(0, 10, 11, 9, 10),
  candle(1, 10, 14, 10, 13),
  candle(2, 14, 15, 13, 14),
];
const bullOb = (): Candle[] => [
  candle(0, 10, 11, 9, 10),
  candle(1, 11, 13, 10, 12),
  candle(2, 12, 15, 11, 14), // Strict swing high, knowable only at index 4.
  candle(3, 14, 14, 11, 12), // Last opposing candle: body 12..14.
  candle(4, 12, 14, 11, 13),
  candle(5, 13, 17, 12, 16), // First close break, not its wick or origin time.
];
const mirror = (candles: Candle[]): Candle[] => candles.map(item => ({ ...item,
  open: 30 - item.open, high: 30 - item.low, low: 30 - item.high, close: 30 - item.close,
}));
const zonesOf = (candles: Candle[], type: 'FVG' | 'OB'): RuleIndicatorZone[] => detectRuleIndicators(candles).zones.filter(zone => zone.type === type);

describe('deterministic FVG indicators', () => {
  it('uses exact bullish wick bounds and middle displacement after the third close', () => {
    const input = bullGap();
    const snapshot = detectRuleIndicators(input);
    expect(snapshot).toMatchObject({ version: '1.0', asOf: input[2].timestamp, candleCount: 3, parameters: RULE_INDICATOR_PARAMETERS });
    expect(snapshot.zones).toHaveLength(1);
    expect(snapshot.zones[0]).toMatchObject({ type: 'FVG', direction: 'bullish', status: 'active',
      originTime: input[0].timestamp, formedAt: input[2].timestamp, endTime: input[2].timestamp,
      lowerPrice: 11, upperPrice: 13, midpoint: 12, mitigation: 0, firstTouchTime: null, resolvedTime: null,
      evidenceTimes: input.map(item => item.timestamp),
    });
  });

  it('detects the symmetric bearish gap without rounding its price or timestamp', () => {
    const input = mirror(bullGap());
    expect(zonesOf(input, 'FVG')[0]).toMatchObject({ direction: 'bearish', lowerPrice: 17, upperPrice: 19, midpoint: 18 });
  });

  it.each(['bullish', 'bearish'] as const)('does not treat touching wick boundaries as a %s FVG', direction => {
    const input = bullGap();
    input[2].low = 11;
    expect(zonesOf(direction === 'bearish' ? mirror(input) : input, 'FVG')).toEqual([]);
  });

  it.each(['bullish', 'bearish'] as const)('requires the middle close beyond the first wick for a %s FVG', direction => {
    const input = bullGap();
    input[1].close = 11;
    expect(zonesOf(direction === 'bearish' ? mirror(input) : input, 'FVG')).toEqual([]);
  });

  it('does not count any formation candle as a touch or mitigation', () => {
    const zone = zonesOf(bullGap(), 'FVG')[0];
    expect(zone.firstTouchTime).toBeNull();
    expect(zone.mitigation).toBe(0);
    expect(zone.status).toBe('active');
  });

  it('tracks first touch and maximum partial wick mitigation without reducing it on later bounces', () => {
    const input = [...bullGap(), candle(3, 14, 15, 12.5, 14), candle(4, 14, 15, 12.75, 14)];
    const zone = zonesOf(input, 'FVG')[0];
    expect(zone).toMatchObject({ status: 'partial', mitigation: 0.25, firstTouchTime: input[3].timestamp,
      endTime: input[4].timestamp, resolvedTime: null });
  });

  it.each(['bullish', 'bearish'] as const)('fully fills a %s FVG on a far-edge wick even when the close recovers', direction => {
    const base = [...bullGap(), candle(3, 14, 15, 12.5, 14), candle(4, 14, 15, 11, 14), candle(5, 14, 16, 13, 15)];
    const input = direction === 'bearish' ? mirror(base) : base;
    expect(zonesOf(input, 'FVG')[0]).toMatchObject({ status: 'filled', mitigation: 1,
      firstTouchTime: input[3].timestamp, resolvedTime: input[4].timestamp, endTime: input[4].timestamp });
  });

  it('records an exact near-edge wick touch without fabricating positive penetration', () => {
    const input = [...bullGap(), candle(3, 14, 15, 13, 14)];
    expect(zonesOf(input, 'FVG')[0]).toMatchObject({ status: 'partial', mitigation: 0, firstTouchTime: input[3].timestamp });
  });
});

describe('confirmed swing close-break order-block indicators', () => {
  it('creates a bullish opposing body only after a 2/2 swing confirmation and later close break', () => {
    const input = bullOb();
    for (let length = 0; length < input.length; length++) {
      expect(zonesOf(input.slice(0, length), 'OB')).toEqual([]);
    }
    expect(zonesOf(input, 'OB')).toHaveLength(1);
    expect(zonesOf(input, 'OB')[0]).toMatchObject({ direction: 'bullish', status: 'active',
      originTime: input[3].timestamp, formedAt: input[5].timestamp, lowerPrice: 12, upperPrice: 14, midpoint: 13,
      firstTouchTime: null, resolvedTime: null, mitigation: 0,
      evidenceTimes: [input[2].timestamp, input[3].timestamp, input[4].timestamp, input[5].timestamp],
    });
    // These candles overlap on their wicks; an FVG is not a prerequisite for OB.
    expect(zonesOf(input, 'FVG')).toEqual([]);
  });

  it('creates the symmetric bearish order block from the last bullish body', () => {
    const input = mirror(bullOb());
    expect(zonesOf(input, 'OB')[0]).toMatchObject({ direction: 'bearish', lowerPrice: 16, upperPrice: 18,
      originTime: input[3].timestamp, formedAt: input[5].timestamp });
  });

  it('does not create an OB for a wick-only break or an exactly equal close', () => {
    const input = bullOb();
    input[5].close = 15;
    expect(zonesOf(input, 'OB')).toEqual([]);
    input[5].close = 14;
    expect(zonesOf(input, 'OB')).toEqual([]);
    input.push(candle(6, 14, 17, 13, 16));
    expect(zonesOf(input, 'OB')[0].formedAt).toBe(input[6].timestamp);
  });

  it('does not invent a swing on equal neighbouring highs', () => {
    const input = bullOb();
    input[3].high = 15;
    expect(zonesOf(input, 'OB')).toEqual([]);
  });

  it('does not classify a doji or same-direction candle as the opposing body', () => {
    const input = bullOb();
    input[3].open = 12;
    input[3].close = 14;
    input[4].open = input[4].close;
    expect(zonesOf(input, 'OB')).toEqual([]);
  });

  it('respects the 12-bar lookback and does not postpone a consumed break until an opposing candle appears', () => {
    const input = bullOb().slice(0, 5);
    for (let index = 5; index < 17; index++) input.push(candle(index, 12, 14, 11, 13));
    input.push(candle(17, 13, 17, 12, 16));
    expect(zonesOf(input, 'OB')).toEqual([]);
    input.push(candle(18, 16, 17, 15, 15.5), candle(19, 15.5, 18, 15, 17));
    expect(zonesOf(input, 'OB')).toEqual([]);
  });

  it('includes an opposing body exactly 12 candles before the break', () => {
    const input = bullOb().slice(0, 5);
    for (let index = 5; index < 15; index++) input.push(candle(index, 12, 14, 11, 13));
    input.push(candle(15, 13, 17, 12, 16));
    expect(zonesOf(input, 'OB')[0]).toMatchObject({ originTime: input[3].timestamp, formedAt: input[15].timestamp });
  });

  it.each(['bullish', 'bearish'] as const)('tests a %s OB by wick, but invalidates only on a later far-edge close', direction => {
    const base = [...bullOb(), candle(6, 16, 17, 13, 15), candle(7, 15, 16, 11, 13)];
    const input = direction === 'bearish' ? mirror(base) : base;
    const tested = zonesOf(input, 'OB')[0];
    expect(tested).toMatchObject({ status: 'tested', mitigation: 1, firstTouchTime: input[6].timestamp,
      resolvedTime: null, endTime: input[7].timestamp });
    const next = candle(8, 13, 14, 10, 11);
    input.push(direction === 'bearish' ? mirror([next])[0] : next);
    const invalid = zonesOf(input, 'OB')[0];
    expect(invalid).toMatchObject({ status: 'invalidated', mitigation: 1, firstTouchTime: input[6].timestamp,
      resolvedTime: input[8].timestamp, endTime: input[8].timestamp });
  });

  it('prioritizes invalidation over a simultaneous first touch and freezes the resolved end', () => {
    const input = [...bullOb(), candle(6, 16, 17, 10, 11), candle(7, 11, 18, 10, 17)];
    expect(zonesOf(input, 'OB')[0]).toMatchObject({ status: 'invalidated', firstTouchTime: input[6].timestamp,
      resolvedTime: input[6].timestamp, endTime: input[6].timestamp });
  });

  it('treats a far-edge equal close as a test, not invalidation', () => {
    const input = [...bullOb(), candle(6, 16, 17, 11, 12)];
    expect(zonesOf(input, 'OB')[0]).toMatchObject({ status: 'tested', resolvedTime: null });
  });

  it('uses each broken swing once and never duplicates an OB origin and direction', () => {
    const input = [...bullOb(), candle(6, 16, 18, 15, 17), candle(7, 17, 19, 16, 18), candle(8, 18, 20, 17, 19)];
    expect(zonesOf(input, 'OB')).toHaveLength(1);
    const ids = detectRuleIndicators(input).zones.map(zone => zone.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('deduplicates the same opposing body even after a second distinct confirmed swing break', () => {
    const input = [...bullOb(), candle(6, 15.8, 16.8, 15.5, 16), candle(7, 15.5, 16.5, 15.5, 16),
      candle(8, 16, 19, 15.5, 18)];
    // Index 5 becomes a new confirmed swing high at index 7. Its index 8
    // break still cites index 3, which already belongs to the first OB.
    expect(zonesOf(input, 'OB')).toHaveLength(1);
    expect(zonesOf(input, 'OB')[0].formedAt).toBe(input[5].timestamp);
  });
});

describe('rule indicator input boundaries and historical stability', () => {
  it('accepts short histories without the model API minimum and returns an empty snapshot for no data', () => {
    expect(detectRuleIndicators([])).toMatchObject({ asOf: null, candleCount: 0, zones: [] });
    expect(detectRuleIndicators(bullGap().slice(0, 2)).zones).toEqual([]);
  });

  it('requires the caller to exclude an unclosed final candle and never guesses closure from timestamps', () => {
    const loaded = bullGap();
    const closed = loaded.slice(0, -1);
    expect(detectRuleIndicators(closed).zones).toEqual([]);
    expect(detectRuleIndicators(loaded).zones).toHaveLength(1);
  });

  it.each([100, 1e-14])('does not invent zones in a flat market at price %s', price => {
    const input = Array.from({ length: 30 }, (_, index) => candle(index, price, price, price, price));
    expect(detectRuleIndicators(input).zones).toEqual([]);
  });

  it.each([1e-14, 1_000])('keeps exact source bounds at scale %s', factor => {
    const input = bullGap().map(item => ({ ...item, open: item.open * factor, high: item.high * factor,
      low: item.low * factor, close: item.close * factor }));
    const zone = zonesOf(input, 'FVG')[0];
    expect(zone.lowerPrice).toBe(input[0].high);
    expect(zone.upperPrice).toBe(input[2].low);
    expect(zone.upperPrice).toBeGreaterThan(zone.lowerPrice);
  });

  it('retains early historical zones even after more than 300 later candles', () => {
    const input = bullGap();
    const firstId = zonesOf(input, 'FVG')[0].id;
    for (let index = 3; index < 450; index++) input.push(candle(index, 14, 15, 13.5, 14));
    expect(zonesOf(input, 'FVG').find(zone => zone.id === firstId)).toMatchObject({ status: 'active',
      originTime: input[0].timestamp, formedAt: input[2].timestamp, endTime: input[449].timestamp });
  });

  it('produces deterministic timestamp IDs and does not mutate candles or prior returned snapshots', () => {
    const input = bullOb();
    const copy = structuredClone(input);
    input.forEach(Object.freeze);
    Object.freeze(input);
    const first = detectRuleIndicators(input);
    const saved = structuredClone(first);
    expect(detectRuleIndicators(input)).toEqual(first);
    expect(input).toEqual(copy);
    detectRuleIndicators([...input, candle(6, 16, 17, 10, 11)]);
    expect(first).toEqual(saved);
    expect(first.zones[0].id).toContain(String(first.zones[0].originTime));
    // A shifted window changes local detection context, not the identity of an
    // FVG that still has all three of its source candles available.
    const prefix = candle(-1, 10, 11, 9, 10);
    expect(zonesOf([prefix, ...bullGap()], 'FVG').find(zone => zone.formedAt === bullGap()[2].timestamp)?.id)
      .toBe(zonesOf(bullGap(), 'FVG')[0].id);
  });

  it('never lets later swing confirmations backdate a zone into an earlier prefix', () => {
    const input = [...bullOb(), candle(6, 16, 18, 15, 17), candle(7, 17, 17.5, 14, 15),
      candle(8, 15, 16, 13, 14), candle(9, 14, 20, 13, 19)];
    const full = detectRuleIndicators(input);
    for (let length = 1; length <= input.length; length++) {
      const prefix = detectRuleIndicators(input.slice(0, length));
      const known = full.zones.filter(zone => zone.formedAt <= input[length - 1].timestamp);
      expect(prefix.zones.map(zone => zone.id)).toEqual(known.map(zone => zone.id));
      for (const zone of prefix.zones) {
        const future = full.zones.find(item => item.id === zone.id)!;
        for (const key of ['id', 'type', 'direction', 'originTime', 'formedAt', 'lowerPrice', 'upperPrice', 'evidenceTimes'] as const) {
          expect(zone[key]).toEqual(future[key]);
        }
        expect(zone.evidenceTimes.every(time => time <= zone.formedAt)).toBe(true);
      }
    }
  });

  it.each([
    ['duplicate timestamps', (input: Candle[]) => { input[1].timestamp = input[0].timestamp; }],
    ['descending timestamps', (input: Candle[]) => { input.reverse(); }],
    ['fractional timestamps', (input: Candle[]) => { input[0].timestamp += 0.5; }],
    ['missing values', (input: Candle[]) => { input[0].open = undefined as unknown as number; }],
    ['nonfinite values', (input: Candle[]) => { input[0].high = Infinity; }],
    ['negative prices', (input: Candle[]) => { input[0].low = -1; }],
    ['inconsistent OHLC', (input: Candle[]) => { input[0].high = 5; }],
    ['negative volume', (input: Candle[]) => { input[0].volume = -1; }],
  ] as const)('rejects %s explicitly instead of silently repairing candles', (_, edit) => {
    const input = bullGap();
    edit(input);
    expect(() => detectRuleIndicators(input)).toThrow();
  });

  it('rejects more than 2000 input candles instead of silently clipping earlier evidence', () => {
    const input = Array.from({ length: 2001 }, (_, index) => candle(index, 10, 11, 9, 10));
    expect(() => detectRuleIndicators(input)).toThrow(/2000/);
  });
});
