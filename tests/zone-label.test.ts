import { describe, expect, it, vi } from 'vitest';
import { drawZoneLabel } from '../src/chart/zoneLabel';

function context() {
  const operations: { name: string; args: unknown[]; font: unknown; align: unknown; baseline: unknown }[] = [];
  const ctx: Record<string, unknown> = { font: '12px serif', textAlign: 'left', textBaseline: 'alphabetic' };
  const states: { font: unknown; textAlign: unknown; textBaseline: unknown }[] = [];
  ctx.save = vi.fn(() => { states.push({ font: ctx.font, textAlign: ctx.textAlign, textBaseline: ctx.textBaseline }); });
  ctx.restore = vi.fn(() => { Object.assign(ctx, states.pop()); });
  ctx.measureText = vi.fn((text: string) => ({ width: text.length * 5 }));
  for (const name of ['beginPath', 'rect', 'clip', 'fillText', 'fillRect', 'strokeRect', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill']) {
    ctx[name] = vi.fn((...args: unknown[]) => operations.push({ name, args, font: ctx.font, align: ctx.textAlign, baseline: ctx.textBaseline }));
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, operations };
}

const viewport = { width: 200, height: 100 };
const bounds = { left: 20, top: 10, right: 120, bottom: 50 };

describe('minimal FVG / OB zone labels', () => {
  it('can reserve the real centered text before painting foreground lines without duplicating its reservation', () => {
    const h = context(), occupied: { left: number; top: number; width: number; height: number }[] = [];
    const box = drawZoneLabel(h.ctx, 'FVG', bounds, viewport, occupied, false);
    expect(box).not.toBeNull(); expect(occupied).toHaveLength(1); expect(h.operations).toEqual([]);
    expect(drawZoneLabel(h.ctx, 'FVG', bounds, viewport)).toEqual(box);
    expect(occupied).toHaveLength(1);
    expect(h.operations.filter(op => op.name === 'fillText')).toHaveLength(1);
  });
  it.each(['FVG', 'OB'])('draws %s as only small centered text with no badge, border or leader line', text => {
    const h = context();
    const hit = drawZoneLabel(h.ctx, text, bounds, viewport);
    expect(h.operations.filter(op => op.name === 'fillText')).toEqual([
      expect.objectContaining({ args: [text, 70, 30], font: expect.stringContaining('9px Arial'), align: 'center', baseline: 'middle' }),
    ]);
    expect(h.operations.map(op => op.name)).toEqual(['beginPath', 'rect', 'clip', 'fillText']);
    expect(h.operations.find(op => op.name === 'rect')?.args).toEqual([20, 10, 100, 40]);
    expect(hit).not.toBeNull();
    expect(hit!.left).toBeLessThan(70);
    expect(hit!.left + hit!.width).toBeGreaterThan(70);
    expect(hit!.top + hit!.height / 2).toBe(30);
    expect(hit!.height).toBe(9);
    expect(h.ctx.font).toBe('12px serif');
    expect(h.ctx.textAlign).toBe('left');
    expect(h.ctx.textBaseline).toBe('alphabetic');
  });

  it('keeps the true center when partially offscreen and clips both text and click geometry', () => {
    const h = context();
    const hit = drawZoneLabel(h.ctx, 'FVG', { left: -98, top: -19, right: 102, bottom: 21 }, viewport);
    expect(h.operations.find(op => op.name === 'fillText')?.args).toEqual(['FVG', 2, 1]);
    expect(h.operations.find(op => op.name === 'rect')?.args).toEqual([0, 0, 102, 21]);
    expect(hit).toEqual({ left: 0, top: 0, width: 11.5, height: 5.5 });
  });

  it.each([
    { left: -100, top: 10, right: 20, bottom: 50 },
    { left: 180, top: 10, right: 300, bottom: 50 },
    { left: 20, top: -50, right: 120, bottom: 10 },
    { left: 20, top: 90, right: 120, bottom: 140 },
  ])('hides a label whose real center is outside the viewport instead of pinning it to an edge: %o', offscreen => {
    const h = context();
    expect(drawZoneLabel(h.ctx, 'FVG', offscreen, viewport)).toBeNull();
    expect(h.operations).toEqual([]);
  });

  it.each([
    { left: 20, top: 10, right: 20, bottom: 50 },
    { left: 20, top: 10, right: 38.9, bottom: 50 },
    { left: 20, top: 10, right: 120, bottom: 18.9 },
  ])('does not turn a narrow or thin zone into an oversized label: %o', small => {
    const h = context();
    expect(drawZoneLabel(h.ctx, 'FVG', small, viewport)).toBeNull();
    expect(h.operations).toEqual([]);
    expect(h.ctx.font).toBe('12px serif');
  });

  it('allows a label exactly at the minimum width and height', () => {
    const h = context();
    expect(drawZoneLabel(h.ctx, 'FVG', { left: 20, top: 10, right: 39, bottom: 19 }, viewport)).toEqual({ left: 20, top: 10, width: 19, height: 9 });
    expect(h.operations.find(op => op.name === 'fillText')?.args).toEqual(['FVG', 29.5, 14.5]);
  });

  it.each([
    { bounds: { ...bounds, left: Number.NaN }, viewport },
    { bounds: { ...bounds, right: Number.POSITIVE_INFINITY }, viewport },
    { bounds: { ...bounds, right: 10 }, viewport },
    { bounds, viewport: { width: 0, height: 100 } },
    { bounds, viewport: { width: 200, height: -1 } },
  ])('ignores invalid geometry without canvas operations: %o', value => {
    const h = context();
    expect(drawZoneLabel(h.ctx, 'OB', value.bounds, value.viewport)).toBeNull();
    expect(h.operations).toEqual([]);
  });
});
