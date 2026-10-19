import { describe, expect, it } from 'vitest';
import { analysisJsonSchema, STRUCTURE_TYPES, validateAnalysis, validateAnalysisEnvelope, type Analysis } from '../shared/analysis';
import { createMockAnalysis } from '../shared/mock';
import { SAMPLE_CANDLES } from '../shared/sample';
import { validateCandles } from '../shared/market';

const mock = () => createMockAnalysis(SAMPLE_CANDLES);

describe('analysis provenance contract', () => {
  const envelope = () => ({ analysis: mock(), source: 'ai', model: 'test-model', analyzedBars: SAMPLE_CANDLES.length,
    generatedAt: new Date().toISOString(), provider: 'codex', billing: 'chatgpt-plan',
    usage: { inputTokens: 5000, cachedInputTokens: 1000, outputTokens: 800 } });

  it('accepts Codex subscription provenance and validated token counts', () => {
    expect(validateAnalysisEnvelope(envelope(), SAMPLE_CANDLES).provider).toBe('codex');
  });

  it.each([
    { billing: 'api' }, { source: 'mock' }, { provider: 'openai-compatible' },
    { usage: { inputTokens: 10, cachedInputTokens: 20, outputTokens: 5 } },
    { usage: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 } },
  ])('rejects inconsistent or invalid model metadata %j', change => {
    expect(() => validateAnalysisEnvelope({ ...envelope(), ...change }, SAMPLE_CANDLES)).toThrow(/校验失败/);
  });
});

describe('analysis contract and coordinate validation', () => {
  it('produces deterministic sample analysis with all eight types and explicit candidate states', () => {
    const analysis = mock();
    expect(new Set(analysis.structures.map((structure) => structure.type))).toEqual(new Set(STRUCTURE_TYPES));
    expect(analysis.structures.some((structure) => structure.status === 'candidate')).toBe(true);
    expect(validateAnalysis(analysis, SAMPLE_CANDLES)).toEqual(analysis);
    expect(mock()).toEqual(analysis);
  });

  it('adapts mock coordinates to uploaded prices rather than hardcoding sample prices', () => {
    const scaled = SAMPLE_CANDLES.map((candle) => ({ ...candle, open: candle.open / 1000, high: candle.high / 1000, low: candle.low / 1000, close: candle.close / 1000 }));
    const analysis = createMockAnalysis(scaled);
    expect(analysis.structures.length).toBeGreaterThan(0);
    expect(analysis.structures.every((structure) => structure.price < 100)).toBe(true);
    expect(analysis.keyLevels.every((level) => level.price < 100)).toBe(true);
  });

  it('uses a strict provider JSON Schema without schema dialect/ref wrapping', () => {
    const schema = analysisJsonSchema as { type: string; additionalProperties: boolean; properties: Record<string, unknown>; required: string[]; $schema?: unknown; $ref?: unknown };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.$schema).toBeUndefined();
    expect(schema.$ref).toBeUndefined();
  });

  it('rejects malformed JSON shapes, unknown fields, enums and nonfinite prices', () => {
    expect(() => validateAnalysis({ ...mock(), debug: 'unexpected' }, SAMPLE_CANDLES)).toThrow(/校验失败/);
    expect(() => validateAnalysis({ ...mock(), bias: 'certain-buy' }, SAMPLE_CANDLES)).toThrow(/校验失败/);
    expect(() => validateAnalysis({ ...mock(), uncertainties: [] }, SAMPLE_CANDLES)).toThrow(/校验失败/);
    const analysis = mock();
    analysis.structures[0].price = Infinity;
    expect(() => validateAnalysis(analysis, SAMPLE_CANDLES)).toThrow(/校验失败/);
  });

  it('rejects fabricated timestamps and out-of-window structure prices', () => {
    const analysis = mock();
    analysis.structures[0].startTime += 1;
    expect(() => validateAnalysis(analysis, SAMPLE_CANDLES)).toThrow(/不存在的时间/);
    const outOfPrice = mock();
    outOfPrice.structures[0].price = 1;
    expect(() => validateAnalysis(outOfPrice, SAMPLE_CANDLES)).toThrow(/价格超出/);
  });

  it('rejects reversed ranges and swing points spanning several candles', () => {
    const analysis = mock();
    const line = analysis.structures.find((structure) => structure.type === 'BOS')!;
    [line.startTime, line.endTime] = [line.endTime, line.startTime];
    expect(() => validateAnalysis(analysis, SAMPLE_CANDLES)).toThrow(/起始时间/);
    const swing = mock();
    swing.structures[0].endTime = SAMPLE_CANDLES[SAMPLE_CANDLES.length - 1].timestamp;
    expect(() => validateAnalysis(swing, SAMPLE_CANDLES)).toThrow(/摆动点/);
  });

  it('pins swing coordinates to the actual candle high or low', () => {
    const analysis = mock();
    analysis.structures[0].price -= 0.1;
    expect(() => validateAnalysis(analysis, SAMPLE_CANDLES)).toThrow(/对应 K 线/);
  });

  it('rejects a low used as a high-point coordinate even for tiny valid prices', () => {
    const tiny = SAMPLE_CANDLES.map((candle) => ({ ...candle, open: candle.open * 1e-14, high: candle.high * 1e-14, low: candle.low * 1e-14, close: candle.close * 1e-14 }));
    const analysis = createMockAnalysis(validateCandles(tiny));
    const swing = analysis.structures.find((structure) => structure.type === 'HH')!;
    swing.price = tiny.find((candle) => candle.timestamp === swing.startTime)!.low;
    expect(() => validateAnalysis(analysis, tiny)).toThrow(/对应 K 线/);
  });

  it('does not label equal highs/lows as lower structures, then classifies the next unequal pivot', () => {
    const candles = Array.from({ length: 15 }, (_, index) => ({
      timestamp: 1_700_000_000 + index * 3_600,
      open: 100, close: 100, volume: 0,
      high: index === 12 ? 112 : index === 2 || index === 7 ? 110 : 101,
      low: index === 12 ? 88 : index === 2 || index === 7 ? 90 : 99,
    }));
    const analysis = createMockAnalysis(validateCandles(candles));
    expect(analysis.structures.filter((structure) => structure.startTime === candles[7].timestamp)).toEqual([]);
    expect(analysis.structures.filter((structure) => structure.startTime === candles[12].timestamp).map((structure) => structure.type)).toEqual(['HH', 'LL']);
  });

  it('returns a neutral, empty structure set for valid flat/no-pivot data, including microprices', () => {
    for (const price of [100, 1e-14]) {
      const candles = Array.from({ length: 10 }, (_, index) => ({ timestamp: 1_700_000_000 + index * 3_600, open: price, high: price, low: price, close: price, volume: 0 }));
      const analysis = createMockAnalysis(validateCandles(candles));
      expect(analysis.trend).toBe('neutral');
      expect(analysis.structures).toEqual([]);
      expect(analysis.opportunities).toEqual([]);
      expect(analysis.keyLevels.every((level) => level.price === price)).toBe(true);
    }
  });

  it('ends invalidated historical OBs at their invalidation candle and excludes them from observation plans', () => {
    const analysis = mock();
    const ob = analysis.structures.find((structure) => structure.id === 'ob-140')!;
    const firstInvalidation = SAMPLE_CANDLES.find((candle) => candle.timestamp > ob.startTime && candle.close > ob.priceEnd!)!;
    expect(ob.endTime).toBe(firstInvalidation.timestamp);
    expect(ob.endTime).toBeLessThan(SAMPLE_CANDLES.at(-1)!.timestamp);
    expect(ob.rationale).toContain('已失效');
    expect(analysis.opportunities.flatMap((opportunity) => opportunity.structureIds)).not.toContain(ob.id);
  });

  it('does not revive an OB invalidated on the latest candle just because its endTime equals the latest time', () => {
    const latest = SAMPLE_CANDLES.at(-1)!;
    const candles = [...SAMPLE_CANDLES, { timestamp: latest.timestamp + 3_600, open: latest.close, high: latest.close + 50, low: 59_900, close: 60_000, volume: 300 }];
    const analysis = createMockAnalysis(validateCandles(candles));
    const oldOb = analysis.structures.find((structure) => structure.id === 'ob-170')!;
    expect(oldOb).toBeDefined();
    expect(oldOb.endTime).toBe(candles.at(-1)!.timestamp);
    expect(oldOb.rationale).toContain('已失效');
    expect(analysis.opportunities.flatMap((opportunity) => opportunity.structureIds)).not.toContain('ob-170');
  });

  it('keeps tiny observation zone prices positive in the human-readable trigger', () => {
    const tiny = SAMPLE_CANDLES.map((candle) => ({ ...candle, open: candle.open * 1e-14, high: candle.high * 1e-14, low: candle.low * 1e-14, close: candle.close * 1e-14 }));
    const analysis = createMockAnalysis(validateCandles(tiny));
    expect(analysis.opportunities.length).toBeGreaterThan(0);
    const range = analysis.opportunities[0].trigger.match(/价格回访 (\S+)–(\S+) 区域/)!;
    expect(Number(range[1])).toBeGreaterThan(0);
    expect(Number(range[2])).toBeGreaterThan(Number(range[1]));
  });

  it('requires increasing lower/upper zone prices and null priceEnd for lines/points', () => {
    const analysis = mock();
    const zone = analysis.structures.find((structure) => structure.type === 'FVG')!;
    zone.priceEnd = zone.price;
    expect(() => validateAnalysis(analysis, SAMPLE_CANDLES)).toThrow(/上边界/);
    zone.priceEnd = null;
    expect(() => validateAnalysis(analysis, SAMPLE_CANDLES)).toThrow(/上边界/);
    const point = mock();
    point.structures[0].priceEnd = point.structures[0].price;
    expect(() => validateAnalysis(point, SAMPLE_CANDLES)).toThrow(/priceEnd/);
  });

  it('rejects duplicate IDs and opportunity references to invented structures', () => {
    const analysis = mock();
    analysis.structures[1].id = analysis.structures[0].id;
    expect(() => validateAnalysis(analysis, SAMPLE_CANDLES)).toThrow(/ID.*重复/);
    const dangling = mock();
    dangling.opportunities[0].structureIds = ['fabricated-structure'];
    expect(() => validateAnalysis(dangling, SAMPLE_CANDLES)).toThrow(/不存在的结构/);
    const duplicate = mock();
    duplicate.opportunities.push({ ...duplicate.opportunities[0] });
    expect(() => validateAnalysis(duplicate, SAMPLE_CANDLES)).toThrow(/机会 ID/);
  });

  it('accepts empty opportunities when no supported setup exists', () => {
    const analysis: Analysis = { ...mock(), structures: [], opportunities: [], tradeSetups: [] };
    expect(validateAnalysis(analysis, SAMPLE_CANDLES).opportunities).toEqual([]);
  });

  it('validates envelope bar count and runs the same semantic checks before rendering', () => {
    const envelope = { analysis: mock(), source: 'mock', model: 'deterministic-demo', analyzedBars: SAMPLE_CANDLES.length, generatedAt: new Date().toISOString() };
    expect(validateAnalysisEnvelope(envelope, SAMPLE_CANDLES).source).toBe('mock');
    expect(() => validateAnalysisEnvelope({ ...envelope, analyzedBars: 10 }, SAMPLE_CANDLES)).toThrow(/数量不一致/);
    envelope.analysis.structures[0].startTime += 1;
    expect(() => validateAnalysisEnvelope(envelope, SAMPLE_CANDLES)).toThrow(/不存在的时间/);
  });
});

describe('trade setup and liquidity evidence contract', () => {
  it('creates only current candidate plans and actual reclaimed sweeps for the sample', () => {
    const analysis = mock();
    expect(analysis.tradeSetups.length).toBeGreaterThan(0);
    expect(analysis.liquiditySweeps.length).toBeGreaterThan(0);
    expect(new Set(analysis.liquiditySweeps.map(sweep => sweep.side))).toEqual(new Set(['buy-side', 'sell-side']));
    for (const setup of analysis.tradeSetups) {
      expect(setup.status).toBe('candidate');
      expect(setup.anchorTime).toBe(SAMPLE_CANDLES.at(-1)!.timestamp);
    }
    for (const sweep of analysis.liquiditySweeps) {
      const candle = SAMPLE_CANDLES.find(candle => candle.timestamp === sweep.sweepTime)!;
      expect(sweep.status).toBe('confirmed');
      if (sweep.side === 'buy-side') {
        expect(candle.high).toBeGreaterThan(sweep.levelPrice);
        expect(candle.close).toBeLessThan(sweep.levelPrice);
      } else {
        expect(candle.low).toBeLessThan(sweep.levelPrice);
        expect(candle.close).toBeGreaterThan(sweep.levelPrice);
      }
    }
  });

  it('upgrades old 1.0 results and envelopes without inventing new evidence', () => {
    const { tradeSetups: _setups, liquiditySweeps: _sweeps, priceAction: _pa, ...current } = mock();
    const legacy = { ...current, schemaVersion: '1.0' };
    const upgraded = validateAnalysis(legacy, SAMPLE_CANDLES);
    expect(upgraded.schemaVersion).toBe('1.2');
    expect(upgraded.tradeSetups).toEqual([]);
    expect(upgraded.liquiditySweeps).toEqual([]);
    expect(upgraded.priceAction.zones).toEqual([]);
    expect(upgraded.priceAction.summary).toContain('旧版');
    const envelope = { analysis: legacy, source: 'ai', model: 'previous-analysis', analyzedBars: SAMPLE_CANDLES.length, generatedAt: new Date().toISOString() };
    expect(validateAnalysisEnvelope(envelope, SAMPLE_CANDLES).analysis).toEqual(upgraded);
    expect(() => validateAnalysis({ ...legacy, debug: true }, SAMPLE_CANDLES)).toThrow(/校验失败/);
    expect(() => validateAnalysis({ ...legacy, tradeSetups: [] }, SAMPLE_CANDLES)).toThrow(/校验失败/);
    expect(() => validateAnalysis({ ...legacy, priceAction: _pa }, SAMPLE_CANDLES)).toThrow(/校验失败/);
    expect(() => validateAnalysis({ ...current, schemaVersion: '1.1' }, SAMPLE_CANDLES)).toThrow(/校验失败/);
    const old11 = { ...current, schemaVersion: '1.1', tradeSetups: _setups, liquiditySweeps: _sweeps };
    expect(validateAnalysis(old11, SAMPLE_CANDLES).priceAction).toEqual(upgraded.priceAction);
    expect(() => validateAnalysis({ ...old11, priceAction: _pa }, SAMPLE_CANDLES)).toThrow(/校验失败/);
    expect(() => validateAnalysis({ ...old11, schemaVersion: '1.2' }, SAMPLE_CANDLES)).toThrow(/校验失败/);
  });

  it.each([
    ['stop direction', (analysis: Analysis) => { analysis.tradeSetups[0].stopLoss = analysis.tradeSetups[0].entry + 1; }, /止损方向/],
    ['zero risk', (analysis: Analysis) => { analysis.tradeSetups[0].stopLoss = analysis.tradeSetups[0].entry; }, /止损方向/],
    ['target direction', (analysis: Analysis) => { analysis.tradeSetups[0].targets[0].price = analysis.tradeSetups[0].entry - 1; }, /目标/],
    ['target ordering', (analysis: Analysis) => { analysis.tradeSetups[0].targets.reverse(); }, /目标/],
    ['unbounded projection', (analysis: Analysis) => { analysis.tradeSetups[0].targets[1].price = 1e9; }, /合理延伸范围/],
    ['historical plan', (analysis: Analysis) => { analysis.tradeSetups[0].anchorTime = SAMPLE_CANDLES.at(-2)!.timestamp; }, /最后一根/],
    ['future anchor', (analysis: Analysis) => { analysis.tradeSetups[0].anchorTime += 1; }, /不存在的时间/],
    ['unknown opportunity', (analysis: Analysis) => { analysis.tradeSetups[0].opportunityId = 'invented'; }, /不存在的机会/],
    ['unknown structure', (analysis: Analysis) => { analysis.tradeSetups[0].structureIds = ['invented']; }, /不存在的结构/],
    ['duplicate references', (analysis: Analysis) => { const setup = analysis.tradeSetups[0]; setup.structureIds.push(setup.structureIds[0]); }, /重复引用结构/],
    ['duplicate IDs', (analysis: Analysis) => { analysis.tradeSetups.push({ ...analysis.tradeSetups[0] }); }, /ID.*重复/],
  ] as const)('rejects invalid trade geometry or provenance: %s', (_label, mutate, expected) => {
    const analysis = mock();
    mutate(analysis);
    expect(() => validateAnalysis(analysis, SAMPLE_CANDLES)).toThrow(expected);
  });

  it('accepts descending short targets with a stop above entry', () => {
    const analysis = mock();
    const setup = analysis.tradeSetups[0];
    setup.opportunityId = null;
    setup.direction = 'bearish';
    setup.stopLoss = setup.entry + 100;
    setup.targets = [{ price: setup.entry - 200, label: '2R' }, { price: setup.entry - 300, label: '3R' }];
    expect(validateAnalysis(analysis, SAMPLE_CANDLES).tradeSetups[0].direction).toBe('bearish');
  });

  it('rejects finite setup prices when the computed ratio would overflow', () => {
    const candles = validateCandles(Array.from({ length: 10 }, (_, index) => ({
      timestamp: 1_700_000_000 + index * 60, open: 50, high: 101, low: 1e-320, close: 50, volume: 0,
    })));
    const analysis: Analysis = {
      ...mock(), opportunities: [], liquiditySweeps: [], keyLevels: [],
      structures: [{ id: 'basis', type: 'BOS', status: 'candidate', direction: 'bullish',
        startTime: candles[0].timestamp, endTime: candles.at(-1)!.timestamp, price: 50, priceEnd: null,
        rationale: 'Test basis', invalidation: 'Test invalidation' }],
      tradeSetups: [{ ...mock().tradeSetups[0], opportunityId: null, structureIds: ['basis'], anchorTime: candles.at(-1)!.timestamp,
        entry: 1e-320, stopLoss: 5e-321, targets: [{ price: 100, label: 'overflow' }] }],
    };
    expect(() => validateAnalysis(analysis, candles)).toThrow(/盈亏比超出可计算范围/);
  });

  it.each([
    ['invented extreme', (analysis: Analysis) => { analysis.liquiditySweeps[0].extremePrice -= 1; }, /精确对应/],
    ['invented level', (analysis: Analysis) => { analysis.liquiditySweeps[0].levelPrice += 1; }, /精确对应/],
    ['future time', (analysis: Analysis) => { analysis.liquiditySweeps[0].sweepTime += 1; }, /不存在的时间/],
    ['unconfirmed pivot', (analysis: Analysis) => { const sweep = analysis.liquiditySweeps[0]; sweep.sweepTime = SAMPLE_CANDLES[SAMPLE_CANDLES.findIndex(candle => candle.timestamp === sweep.levelTime) + 2].timestamp; }, /右侧 2 根确认/],
    ['duplicate sweep', (analysis: Analysis) => { analysis.liquiditySweeps.push({ ...analysis.liquiditySweeps[0] }); }, /ID.*重复/],
  ] as const)('rejects unsupported liquidity evidence: %s', (_label, mutate, expected) => {
    const analysis = mock();
    mutate(analysis);
    expect(() => validateAnalysis(analysis, SAMPLE_CANDLES)).toThrow(expected);
  });

  it('requires a close reclaim for confirmed sweeps and permits a crossing candidate', () => {
    const analysis = mock();
    const sweep = analysis.liquiditySweeps.find(sweep => sweep.side === 'buy-side')!;
    analysis.liquiditySweeps = [sweep];
    const candles = SAMPLE_CANDLES.map(candle => candle.timestamp === sweep.sweepTime ? { ...candle, close: sweep.levelPrice + 1 } : candle);
    expect(() => validateAnalysis(analysis, candles)).toThrow(/尚未收盘收回/);
    sweep.status = 'candidate';
    expect(validateAnalysis(analysis, candles).liquiditySweeps[0].status).toBe('candidate');
  });

  it('does not recycle a level already broken by an earlier close as a sweep', () => {
    const analysis = mock();
    const sweep = analysis.liquiditySweeps.find(sweep => sweep.side === 'buy-side')!;
    analysis.liquiditySweeps = [sweep];
    const priorIndex = SAMPLE_CANDLES.findIndex(candle => candle.timestamp === sweep.sweepTime) - 1;
    const candles = SAMPLE_CANDLES.map((candle, index) => index === priorIndex
      ? { ...candle, close: sweep.levelPrice + 1, high: Math.max(candle.high, sweep.levelPrice + 1) } : candle);
    expect(() => validateAnalysis(analysis, candles)).toThrow(/已经收盘突破/);
  });

  it('keeps a level eligible when an earlier close only touches it', () => {
    const analysis = mock();
    const sweep = analysis.liquiditySweeps.find(sweep => sweep.side === 'buy-side')!;
    analysis.liquiditySweeps = [sweep];
    const priorIndex = SAMPLE_CANDLES.findIndex(candle => candle.timestamp === sweep.sweepTime) - 1;
    const candles = SAMPLE_CANDLES.map((candle, index) => index === priorIndex
      ? { ...candle, close: sweep.levelPrice, high: Math.max(candle.high, sweep.levelPrice) } : candle);
    expect(validateAnalysis(analysis, candles).liquiditySweeps).toEqual([sweep]);
  });

  it('preserves strict sweep and plan coordinates for micro-priced markets', () => {
    const candles = SAMPLE_CANDLES.map(candle => ({ ...candle, open: candle.open * 1e-14, high: candle.high * 1e-14, low: candle.low * 1e-14, close: candle.close * 1e-14 }));
    const analysis = createMockAnalysis(candles);
    expect(analysis.tradeSetups.length).toBeGreaterThan(0);
    expect(analysis.liquiditySweeps.length).toBeGreaterThan(0);
    analysis.liquiditySweeps[0].extremePrice = analysis.liquiditySweeps[0].levelPrice;
    expect(() => validateAnalysis(analysis, candles)).toThrow(/精确对应/);
  });
});
