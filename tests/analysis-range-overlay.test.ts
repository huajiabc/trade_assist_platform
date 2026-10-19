import { describe, expect, it, vi } from 'vitest';
import type { IPrimitivePaneRenderer, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../shared/market';
import { AnalysisRangeOverlay } from '../src/chart/AnalysisRangeOverlay';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
const candles: Candle[] = Array.from({ length: 30 }, (_, index) => ({
  timestamp: 1_700_000_000 + index * 60, open: 100, high: 103, low: 99, close: 101, volume: 10,
}));
const range = { from: candles[5].timestamp, to: candles[15].timestamp };

function harness() {
  const positions = new Map(candles.map((candle, index) => [candle.timestamp, 100 + index * 10]));
  let spacing = 10;
  const timeToCoordinate = vi.fn((time: UTCTimestamp) => positions.get(Number(time)) ?? null);
  const requestUpdate = vi.fn();
  // Only public time-scale APIs are supplied. No fractional logical-index
  // conversion is available to accidentally collapse both edges to zero.
  const attachment = {
    chart: { timeScale: () => ({ timeToCoordinate, options: () => ({ barSpacing: spacing }) }) },
    requestUpdate,
  } as unknown as SeriesAttachedParameter;
  const context = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '',
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    fillRect: vi.fn(), strokeRect: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    setLineDash: vi.fn(), measureText: vi.fn(() => ({ width: 80 })), fillText: vi.fn(),
  };
  const target = {
    useMediaCoordinateSpace: (draw: (scope: { context: typeof context; mediaSize: { width: number; height: number } }) => void) => {
      draw({ context, mediaSize: { width: 600, height: 300 } });
    },
  } as unknown as Target;
  const overlay = new AnalysisRangeOverlay();
  overlay.attached(attachment);
  const draw = (layer: 'bottom' | 'top') => {
    const view = overlay.paneViews().find(item => item.zOrder?.() === layer)!;
    view.renderer()!.draw(target);
  };
  return { overlay, context, positions, timeToCoordinate, requestUpdate, draw, setSpacing: (next: number) => { spacing = next; } };
}

describe('native analysis-range canvas overlay', () => {
  it('fills the inclusive candle band at actual time coordinates plus half the current bar spacing', () => {
    const { overlay, context, requestUpdate, timeToCoordinate, draw } = harness();
    overlay.setData(candles, range);
    expect(requestUpdate).toHaveBeenCalledOnce();
    draw('bottom');
    expect(timeToCoordinate.mock.calls).toEqual([[range.from], [range.to]]);
    expect(context.fillRect.mock.calls).toEqual([[145, 0, 110, 300]]);
    expect(context.fillStyle).toBe('rgba(80,143,255,.065)');
    expect(context.rect).toHaveBeenCalledWith(0, 0, 600, 300);
    expect(context.clip).toHaveBeenCalledOnce();
  });

  it('draws both boundary lines and centers the exact selected-bar count inside their visible span', () => {
    const { overlay, context, draw } = harness();
    overlay.setData(candles, range);
    draw('top');
    expect(context.moveTo.mock.calls).toEqual([[145, 0], [255, 0]]);
    expect(context.lineTo.mock.calls).toEqual([[145, 300], [255, 300]]);
    expect(context.fillText).toHaveBeenCalledWith('分析范围 · 11 根', 200, 287);
    expect(context.fillRect).toHaveBeenCalledWith(151, 273, 98, 21);
  });

  it('recomputes geometry from the public time scale after zoom and pan without requiring a new selection', () => {
    const { overlay, context, positions, setSpacing, draw } = harness();
    overlay.setData(candles, range);
    draw('bottom');
    expect(context.fillRect).toHaveBeenLastCalledWith(145, 0, 110, 300);
    for (const [index, candle] of candles.entries()) positions.set(candle.timestamp, 80 + index * 20);
    setSpacing(20);
    context.fillRect.mockClear();
    draw('bottom');
    expect(context.fillRect.mock.calls).toEqual([[170, 0, 220, 300]]);
    draw('top');
    expect(context.moveTo.mock.calls).toEqual([[170, 0], [390, 0]]);
    expect(context.fillText).toHaveBeenCalledWith('分析范围 · 11 根', 280, 287);
  });

  it.each(['from', 'to'] as const)('does not draw when the %s candle is unavailable instead of snapping to a nearby bar', endpoint => {
    const { overlay, context, positions, draw } = harness();
    positions.delete(range[endpoint]);
    overlay.setData(candles, range);
    draw('bottom'); draw('top');
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.moveTo).not.toHaveBeenCalled();
    expect(context.fillText).not.toHaveBeenCalled();
  });

  it('accepts a candle centered at coordinate zero and clips its half-bar band at the viewport edge', () => {
    const { overlay, context, positions, draw } = harness();
    positions.set(range.from, 0); positions.set(range.to, 100);
    overlay.setData(candles, range);
    draw('bottom');
    expect(context.fillRect).toHaveBeenCalledWith(-5, 0, 110, 300);
    expect(context.clip).toHaveBeenCalledOnce();
    draw('top');
    expect(context.moveTo.mock.calls).toEqual([[-5, 0], [105, 0]]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects a non-finite endpoint coordinate %s without issuing canvas commands', coordinate => {
    const { overlay, context, positions, draw } = harness();
    positions.set(range.from, coordinate);
    overlay.setData(candles, range);
    draw('bottom'); draw('top');
    expect(context.save).not.toHaveBeenCalled();
    expect(context.fillRect).not.toHaveBeenCalled();
  });

  it('uses a distinct preview band and label while selection is still in progress', () => {
    const { overlay, context, draw } = harness();
    overlay.setData(candles, range, true);
    draw('bottom');
    expect(context.fillStyle).toBe('rgba(80,143,255,.13)');
    draw('top');
    expect(context.setLineDash).toHaveBeenCalledWith([4, 4]);
    expect(context.fillText).toHaveBeenCalledWith('选择中 · 11 根', 200, 287);
  });

  it('stops drawing after selection is cleared or the primitive is detached', () => {
    const { overlay, context, draw } = harness();
    overlay.setData(candles, null);
    draw('bottom'); draw('top');
    expect(context.fillRect).not.toHaveBeenCalled();
    overlay.setData(candles, range);
    overlay.detached();
    draw('bottom'); draw('top');
    expect(context.fillRect).not.toHaveBeenCalled();
  });
});
