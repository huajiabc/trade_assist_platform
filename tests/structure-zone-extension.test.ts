import { describe, expect, it, vi } from 'vitest';
import type { IPrimitivePaneRenderer, Logical, SeriesAttachedParameter } from 'lightweight-charts';
import type { Structure } from '../shared/analysis';
import type { Candle } from '../shared/market';
import { StructureOverlay } from '../src/chart/StructureOverlay';

// Irregular elapsed time deliberately differs from bar count.
const candles: Candle[] = Array.from({ length: 24 }, (_, index) => ({
  timestamp: 1_700_000_000 + index * index * 60,
  open: 100, high: 120, low: 80, close: 110, volume: 100,
}));
const structure = (changes: Partial<Structure> = {}): Structure => ({
  id: 'model-zone', type: 'FVG', status: 'confirmed', direction: 'bullish',
  startTime: candles[2].timestamp, endTime: candles[20].timestamp,
  price: 80, priceEnd: 120, rationale: 'Model evidence', invalidation: 'Full fill', ...changes,
});

/** Public primitive lifecycle and public scales only; records actual canvas output. */
function harness() {
  const positions = new Map(candles.map((candle, index) => [candle.timestamp, 50 + index * 20]));
  const scale = {
    timeToCoordinate: vi.fn((time: number) => positions.get(time) ?? null),
    timeToIndex: vi.fn((time: number) => { const index = candles.findIndex(candle => candle.timestamp === time); return index < 0 ? null : index; }),
  };
  const context = {
    fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    fillRect: vi.fn(), strokeRect: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    setLineDash: vi.fn(), measureText: vi.fn((text: string) => ({ width: text.length * 5 })), fillText: vi.fn(),
  };
  const overlay = new StructureOverlay();
  overlay.attached({
    chart: { timeScale: () => scale }, series: { priceToCoordinate: (price: number) => 400 - price * 2 }, requestUpdate: vi.fn(),
  } as unknown as SeriesAttachedParameter);
  const target = {
    useMediaCoordinateSpace: (draw: (scope: { context: typeof context; mediaSize: { width: number; height: number } }) => void) =>
      draw({ context, mediaSize: { width: 600, height: 500 } }),
  } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0];
  const draw = (layer: 'bottom' | 'top') => overlay.paneViews().find(view => view.zOrder?.() === layer)!.renderer()!.draw(target);
  return { overlay, context, positions, scale, draw };
}

describe('model FVG and OB display extension', () => {
  it.each(['FVG', 'OB'] as const)('%s draws five actual bars beyond its start without altering the model result', type => {
    const h = harness();
    const source = Object.freeze(structure({ type }));
    h.overlay.setData([source], source.id, candles);
    h.draw('bottom'); h.draw('top');
    // Index 2 -> 7, x=90 -> 190. No elapsed-time multiplication or latest-bar extension.
    expect(h.context.fillRect).toHaveBeenCalledWith(90, 160, 100, 80);
    expect(h.context.strokeRect).not.toHaveBeenCalled();
    expect(h.context.moveTo).not.toHaveBeenCalled();
    expect(h.context.lineTo).not.toHaveBeenCalled();
    expect(h.context.arc).not.toHaveBeenCalled();
    expect(h.context.fillText.mock.calls).toEqual([[type, 140, 200]]);
    expect(h.context.fillRect.mock.calls).toEqual([[90, 160, 100, 80]]);
    expect(h.scale.timeToCoordinate).toHaveBeenCalledWith(candles[7].timestamp);
    expect(h.scale.timeToCoordinate).not.toHaveBeenCalledWith(candles[20].timestamp);
    expect(h.overlay.hitTest(140, 200)?.externalId).toBe(source.id);
    expect(h.overlay.hitTest(350, 200)).toBeNull();
    expect(source.endTime).toBe(candles[20].timestamp);
    // A selected old zone must not widen the price scale long after its visible band ends.
    expect(h.overlay.autoscaleInfo(8 as Logical, 20 as Logical)).toBeNull();
    expect(h.overlay.autoscaleInfo(0 as Logical, 7 as Logical)?.priceRange).toEqual({ minValue: 80, maxValue: 120 });
  });

  it('stops at an earlier lifecycle endpoint and never adds unavailable future candles', () => {
    const h = harness();
    const earlierEnd = structure({ endTime: candles[4].timestamp });
    h.overlay.setData([earlierEnd], null, candles); h.draw('bottom');
    expect(h.context.fillRect).toHaveBeenCalledWith(90, 160, 40, 80);
    h.context.fillRect.mockClear();
    // Newly formed zone with two available candles must stop there, not start + five intervals.
    h.overlay.setData([structure({ startTime: candles[21].timestamp, endTime: candles[23].timestamp })], null, candles);
    h.draw('bottom');
    expect(h.context.fillRect).toHaveBeenCalledWith(470, 160, 40, 80);
  });

  it('keeps candidate status in the source while drawing only a small centered type name', () => {
    const h = harness(); const source = Object.freeze(structure({ type: 'OB', status: 'candidate' }));
    h.overlay.setData([source], null, candles); h.draw('bottom'); h.draw('top');
    expect(h.context.fillText.mock.calls).toEqual([['OB', 140, 200]]);
    expect(h.context.font).toContain('9px');
    expect(h.context.textAlign).toBe('center');
    expect(h.context.textBaseline).toBe('middle');
    expect(h.context.fillRect.mock.calls).toEqual([[90, 160, 100, 80]]);
    expect(h.context.strokeRect).not.toHaveBeenCalled();
    expect(source.status).toBe('candidate');
    expect(h.overlay.hitTest(140, 200)?.externalId).toBe(source.id);
  });

  it('does not move a centered label outside a narrow or shallow zone', () => {
    const h = harness();
    h.overlay.setData([structure({ endTime: candles[2].timestamp })], null, candles); h.draw('bottom'); h.draw('top');
    expect(h.context.fillRect).toHaveBeenCalledWith(90, 160, 0, 80);
    expect(h.context.fillText).not.toHaveBeenCalled();
    h.context.fillRect.mockClear();
    h.overlay.setData([structure({ priceEnd: 83 })], null, candles); h.draw('bottom'); h.draw('top');
    expect(h.context.fillRect).toHaveBeenCalledWith(90, 234, 100, 6);
    expect(h.context.fillText).not.toHaveBeenCalled();
    expect(h.context.strokeRect).not.toHaveBeenCalled();
  });

  it('does not clamp a label to the viewport edge when the true zone center is offscreen', () => {
    const h = harness();
    for (const [index, candle] of candles.entries()) h.positions.set(candle.timestamp, index * 20 - 130);
    h.overlay.setData([structure()], null, candles); h.draw('bottom'); h.draw('top');
    // A sliver remains visible at x=0..10, but the actual zone center is x=-40.
    expect(h.context.fillRect).toHaveBeenCalledWith(-90, 160, 100, 80);
    expect(h.context.fillText).not.toHaveBeenCalled();
    expect(h.context.strokeRect).not.toHaveBeenCalled();
    expect(h.overlay.hitTest(5, 200)?.externalId).toBe('model-zone');
  });

  it('removes a capped zone entirely when panned left, including labels, hits, and selected autoscale', () => {
    const h = harness(); const source = structure();
    h.overlay.setData([source], source.id, candles); h.draw('top');
    expect(h.overlay.hitTest(140, 200)).not.toBeNull();
    for (const [index, candle] of candles.entries()) h.positions.set(candle.timestamp, index * 20 - 200);
    h.context.fillRect.mockClear(); h.context.strokeRect.mockClear(); h.context.fillText.mockClear();
    h.draw('bottom'); h.draw('top');
    // Original end is still visible (x=200), capped end at index 7 is x=-60.
    expect(h.context.fillRect).not.toHaveBeenCalled();
    expect(h.context.strokeRect).not.toHaveBeenCalled();
    expect(h.context.fillText).not.toHaveBeenCalled();
    expect(h.overlay.hitTest(40, 200)).toBeNull();
    expect(h.overlay.autoscaleInfo(10 as Logical, 23 as Logical)).toBeNull();
  });

  it.each(['startTime', 'endTime'] as const)('does not snap a missing %s to another candle', endpoint => {
    const h = harness(); const source = structure({ [endpoint]: candles[2].timestamp + 1 });
    h.overlay.setData([source], source.id, candles); h.draw('bottom'); h.draw('top');
    expect(h.context.fillRect).not.toHaveBeenCalled();
    expect(h.context.strokeRect).not.toHaveBeenCalled();
    expect(h.context.fillText).not.toHaveBeenCalled();
    expect(h.overlay.autoscaleInfo(0 as Logical, 23 as Logical)).toBeNull();
  });

  it.each(['BOS', 'CHoCH'] as const)('preserves %s event endpoints and price autoscale across the complete event', type => {
    const h = harness(); const source = structure({ type, priceEnd: null });
    h.overlay.setData([source], source.id, candles); h.draw('bottom'); h.draw('top');
    expect(h.context.fillRect).toHaveBeenCalledWith(90, 237, 360, 6);
    expect(h.scale.timeToCoordinate).toHaveBeenCalledWith(candles[20].timestamp);
    expect(h.overlay.autoscaleInfo(15 as Logical, 20 as Logical)?.priceRange).toEqual({ minValue: 80, maxValue: 80 });
  });

  it('keeps a swing point visible with no candle list, independently of zone caps', () => {
    const h = harness(); const source = structure({ type: 'HH', priceEnd: null });
    h.overlay.setData([source], null); h.draw('top');
    expect(h.context.arc).toHaveBeenCalledWith(90, 240, 2, 0, Math.PI * 2);
    expect(h.overlay.hitTest(90, 240)?.externalId).toBe(source.id);
  });
});
