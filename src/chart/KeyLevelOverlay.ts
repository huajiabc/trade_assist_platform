import {
  LineStyle,
  type AutoscaleInfo,
  type CreatePriceLineOptions,
  type IPriceLine,
  type ISeriesPrimitive,
  type PrimitiveHoveredItem,
  type SeriesAttachedParameter,
} from 'lightweight-charts';
import type { Analysis } from '../../shared/analysis';

export type ChartPriceLevel=Analysis['keyLevels'][number]&{appearance?:{color:string;style:'solid'|'dashed'|'dotted';unindexed?:boolean;muted?:boolean}};
type KeyLevels = ChartPriceLevel[];

/** Global research levels have prices but no evidence timestamp. Use native
 * horizontal price lines, without manufacturing candle anchors or signals. */
export class KeyLevelOverlay implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private levels: KeyLevels = [];
  private selectedIndex: number | null = null;
  private multiplier = 1;
  private readonly lines = new Map<number, IPriceLine>();

  attached(parameters: SeriesAttachedParameter): void {
    this.clearLines();
    this.attachment = parameters;
    this.syncLines();
  }

  detached(): void {
    this.clearLines();
    this.attachment = null;
  }

  setData(levels: KeyLevels, selectedIndex: number | null): void {
    this.levels = levels;
    this.selectedIndex = selectedIndex;
    this.syncLines();
  }

  setPriceMultiplier(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0 || this.multiplier === multiplier) return;
    this.multiplier = multiplier;
    this.syncLines();
  }

  /** Only an explicitly selected level expands the automatic price scale.
   * Native price lines otherwise respect the user's current candle viewport. */
  autoscaleInfo(): AutoscaleInfo | null {
    if (!this.attachment || this.selectedIndex === null || !this.lines.has(this.selectedIndex)) return null;
    const price = this.levels[this.selectedIndex].price * this.multiplier;
    return { priceRange: { minValue: price, maxValue: price }, margins: { above: 24, below: 24 } };
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (!this.attachment || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const { width, height } = this.attachment.chart.paneSize(0);
    if (x < 0 || y < 0 || x > width || y > height) return null;
    let nearest: { index: number; distance: number } | null = null;
    for (const index of this.lines.keys()) {
      const coordinate = this.attachment.series.priceToCoordinate(this.levels[index].price * this.multiplier);
      if (coordinate === null || !Number.isFinite(coordinate)) continue;
      const distance = Math.abs(coordinate - y);
      if (distance <= 4 && (!nearest || distance < nearest.distance || distance === nearest.distance && index === this.selectedIndex)) {
        nearest = { index, distance };
      }
    }
    return nearest ? { externalId: `key-level:${nearest.index}`, zOrder: 'top', cursorStyle: 'pointer', distance: nearest.distance } : null;
  }

  private clearLines(): void {
    if (this.attachment) for (const line of this.lines.values()) this.attachment.series.removePriceLine(line);
    this.lines.clear();
  }

  private syncLines(): void {
    if (!this.attachment) return;
    const wanted = new Set<number>();
    this.levels.forEach((level, index) => {
      const price = level.price * this.multiplier;
      if (!Number.isFinite(price) || price <= 0) return;
      wanted.add(index);
      const selected = index === this.selectedIndex;
      const appearance=level.appearance,color=appearance?.color??(selected?'#f0c674':'#8094b5');
      const label = level.label.length > 24 ? `${level.label.slice(0, 23)}…` : level.label;
      const options: CreatePriceLineOptions = {
        id: `key-level:${index}`,
        price,
        title: appearance?.unindexed?label:`${String(index + 1).padStart(2, '0')} · ${label}`,
        color,
        lineWidth: selected ? 2 : 1,
        lineStyle: appearance?.style==='solid'?LineStyle.Solid:appearance?.style==='dotted'?LineStyle.Dotted:LineStyle.Dashed,
        lineVisible: true,
        axisLabelVisible: true,
        axisLabelColor: appearance?'#263346':selected ? '#f0c674' : '#263346',
        axisLabelTextColor: appearance?'#e2e9f4':selected ? '#131722' : '#c5d3e8',
      };
      const line = this.lines.get(index);
      if (line) line.applyOptions(options);
      else this.lines.set(index, this.attachment!.series.createPriceLine(options));
    });
    for (const [index, line] of this.lines) {
      if (wanted.has(index)) continue;
      this.attachment.series.removePriceLine(line);
      this.lines.delete(index);
    }
    this.attachment.requestUpdate();
  }
}
