import { describe, expect, it, vi } from 'vitest';
import { alignedStroke, horizontalStroke } from '../src/chart/drawingStyle';

describe('native overlay pixel alignment and label gaps', () => {
  it.each([1, 1.25, 1.5, 2, 3])('aligns a 1px stroke at DPR %s within half a device pixel of its exact price coordinate', ratio => {
    for (const value of [-12.7, 0, .2, 41, 299.6]) {
      const aligned = alignedStroke(value, ratio);
      const pixels = Math.round(ratio);
      // Both edges must land on actual device pixels instead of blurring
      // across them. Original price projection is not rounded or mutated.
      expect((aligned * ratio - pixels / 2) % 1).toBeCloseTo(0);
      expect(Math.abs(aligned - value)).toBeLessThanOrEqual(.5 / ratio + 1e-9);
    }
  });

  it('leaves a small gap below centered BOS text while retaining both real event endpoints', () => {
    const ctx = { lineWidth: 1, getTransform: () => ({ d: 2 }), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
    const label = Object.freeze({ left: 90, top: 32, width: 24, height: 16 });
    horizontalStroke(ctx as unknown as CanvasRenderingContext2D, 20, 200, 40.2, label);
    expect(ctx.moveTo.mock.calls).toEqual([[20, 40], [117, 40]]);
    expect(ctx.lineTo.mock.calls).toEqual([[87, 40], [200, 40]]);
    expect(ctx.stroke).toHaveBeenCalledOnce();
    expect(label).toEqual({ left: 90, top: 32, width: 24, height: 16 });
  });

  it('keeps the level continuous when collision avoidance moves text above it', () => {
    const ctx = { lineWidth: 1, getTransform: () => ({ d: 1 }), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
    horizontalStroke(ctx as unknown as CanvasRenderingContext2D, -20, 200, 40, { left: 90, top: 2, width: 24, height: 16 });
    expect(ctx.moveTo.mock.calls).toEqual([[-20, 40.5]]);
    expect(ctx.lineTo.mock.calls).toEqual([[200, 40.5]]);
  });
});
