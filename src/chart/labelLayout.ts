export interface LabelBox { left: number; top: number; width: number; height: number }

/** Suppress colliding text only. The original structure geometry is never moved.
 * Place the selected label first so it always remains visible. */
export function reserveLabel(box: LabelBox, occupied: LabelBox[], selected = false, padding = 3): boolean {
  if (!selected && occupied.some((other) => box.left < other.left + other.width + padding
    && box.left + box.width + padding > other.left
    && box.top < other.top + other.height + padding
    && box.top + box.height + padding > other.top)) return false;
  occupied.push(box);
  return true;
}

export interface LabelDensity { mode: 'overview' | 'structure' | 'detail'; main: number; auxiliary: number; showLocal: boolean }
export function labelDensity(barSpacing: number, width: number): LabelDensity {
  const mode = barSpacing < 4 ? 'overview' : barSpacing < 9 ? 'structure' : 'detail';
  return { mode, main: Math.max(2, Math.floor(width / (mode === 'overview' ? 100 : mode === 'structure' ? 65 : 42))),
    auxiliary: mode === 'overview' ? 0 : Math.max(1, Math.floor(width / (mode === 'detail' ? 90 : 150))), showLocal: mode !== 'overview' };
}

/** Only text moves; exact price/time geometry remains unchanged. */
export function placeLabel(preferred: LabelBox, viewport: { width: number; height: number }, occupied: LabelBox[], selected = false, obstacles: readonly LabelBox[] = []): LabelBox | null {
  if (preferred.width <= 0 || preferred.height <= 0 || preferred.width > viewport.width - 4 || preferred.height > viewport.height - 4) return null;
  const left = Math.max(2, Math.min(preferred.left, viewport.width - preferred.width - 2));
  for (const shift of [0, -18, 18, -36, 36, -54, 54, -72, 72]) {
    const box = { ...preferred, left, top: Math.max(2, Math.min(preferred.top + shift, viewport.height - preferred.height - 2)) };
    if (reserveLabel(box, [...occupied, ...obstacles])) { occupied.push(box); return box; }
  }
  if (!selected) return null;
  const box = { ...preferred, left, top: Math.max(2, Math.min(preferred.top, viewport.height - preferred.height - 2)) };
  occupied.push(box); return box;
}

/** One registry per native chart, reset by its first/top structure pass.
 * Draw order: main structures, plans, PA, auxiliary zones. No second canvas. */
export class ChartLabelRegistry {
  private layers = new Map<string, { priority: number; boxes: LabelBox[] }>();
  begin(owner: string, priority: number): LabelBox[] {
    if (owner === 'structures') this.layers.clear();
    const boxes = [...this.layers.entries()].filter(([name, layer]) => name !== owner && layer.priority <= priority).flatMap(([, layer]) => layer.boxes);
    this.layers.set(owner, { priority, boxes: [] }); return boxes;
  }
  commit(owner: string, occupied: LabelBox[], inherited: number): void {
    const layer = this.layers.get(owner); if (layer) layer.boxes = occupied.slice(inherited);
  }
}
