import { describe, expect, it, vi } from 'vitest';
import type { IPrimitivePaneRenderer, SeriesAttachedParameter } from 'lightweight-charts';
import { MarketSessionOverlay } from '../src/chart/MarketSessionOverlay';
import { PHASE_COLORS } from '../shared/marketContext';

const start = Date.parse('2026-10-22T13:20:00Z') / 1000;
const candles = Array.from({ length: 30 }, (_, i) => ({ timestamp: start + i * 60, open: 100, high: 102, low: 99, close: 101, volume: 10 }));
function harness() {
  const overlay = new MarketSessionOverlay(), requestUpdate = vi.fn(), fills: { color: string; x: number; width: number; height: number }[] = [];
  let offset = 0, spacing = 10;
  const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillStyle: '', fillRect(x: number, _y: number, width: number, height: number) { fills.push({ color: this.fillStyle, x, width, height }); } };
  overlay.attached({ requestUpdate, chart: { timeScale: () => ({ options: () => ({ barSpacing: spacing }), timeToCoordinate: (time: number) => (time - start) / 60 * spacing + offset }) } } as unknown as SeriesAttachedParameter);
  const target = { useMediaCoordinateSpace: (draw: (args: unknown) => void) => draw({ context: ctx, mediaSize: { width: 300, height: 400 } }) } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0];
  return { overlay, fills, requestUpdate, ctx, draw: () => { fills.length = 0; overlay.paneViews()[0].renderer()!.draw(target); }, move: (x: number, zoom: number) => { offset = x; spacing = zoom; } };
}
describe('session background primitive', () => {
  it('fills only the premarket band, leaves regular candles unshaded and adds no price or hit-test geometry', () => {
    const h = harness(); h.overlay.setData(candles, 'SNDKUSDT', '1m'); h.draw();
    expect(h.fills).toEqual([{ color: PHASE_COLORS.premarket, x: 0, width: 95, height: 400 }]);
    expect(h.overlay.paneViews()[0].zOrder?.()).toBe('bottom');
    expect(h.overlay).not.toHaveProperty('hitTest'); expect(h.overlay).not.toHaveProperty('autoscaleInfo');
    expect(h.ctx.restore).toHaveBeenCalled(); expect(h.requestUpdate).toHaveBeenCalled();
  });
  it('uses updated native coordinates on every pan/zoom and clips at pane boundaries', () => {
    const h = harness(); h.overlay.setData(candles, 'SNDKUSDT', '1m'); h.move(100, 20); h.draw();
    expect(h.fills[0]).toMatchObject({ x: 90, width: 200 });
    h.move(-200, 10); h.draw(); expect(h.fills).toEqual([]);
    h.move(295, 10); h.draw(); expect(h.fills[0]).toMatchObject({ x: 290, width: 10 });
  });
  it('supports independent hiding, symbol replacement, wide-bar suppression and clean disposal', () => {
    const h = harness();
    for (const [symbol, tf, enabled] of [['SNDKUSDT', '1m', false], ['BTCUSDT', '1m', true], ['SNDKUSDT', '1h', true]] as const) {
      h.overlay.setData(candles, symbol, tf, enabled); h.draw(); expect(h.fills).toEqual([]);
    }
    h.overlay.setData(candles, 'SNDKUSDT', '1m'); h.draw(); expect(h.fills).toHaveLength(1);
    h.overlay.detached(); h.draw(); expect(h.fills).toEqual([]);
  });
});
