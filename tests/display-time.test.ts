import { describe, expect, it } from 'vitest';
import { TickMarkType, type UTCTimestamp } from 'lightweight-charts';
import { formatDisplayTime, shortDisplayTime } from '../shared/displayTime';
import { chartTickFormatter, chartTimeFormatter } from '../src/chart/chartTime';
import { chartImageAnchor, chartImageSchema, imageManifest, validateImageAnchors } from '../shared/analysisInput';
import { imageFixture } from './visual-fixtures';
import { SAMPLE_CANDLES } from '../shared/sample';

const utc = (iso: string) => Date.parse(iso) / 1000;

describe('UTC+8 display without shifting market coordinates', () => {
  it('uses the same fixed timezone across midnight, independently of the host timezone', () => {
    expect(formatDisplayTime(utc('2026-10-26T16:35:42Z'), true)).toBe('2026-10-27 00:35:42');
    expect(shortDisplayTime(utc('2026-10-26T16:35:42Z'))).toBe('10-27 00:35');
  });
  it('rolls dates, months and years forward correctly', () => {
    expect(formatDisplayTime(utc('2026-12-31T18:00:00Z'))).toBe('2027-01-01 02:00');
    expect(formatDisplayTime(utc('2028-02-28T18:00:00Z'))).toBe('2028-02-29 02:00');
  });
  it('formats axis ticks and crosshair labels in the same timezone', () => {
    const time = utc('2026-12-31T18:02:03Z') as UTCTimestamp;
    expect(chartTimeFormatter(time)).toBe('2027-01-01 02:02');
    expect(chartTickFormatter(time, TickMarkType.Year)).toBe('2027');
    expect(chartTickFormatter(time, TickMarkType.Month)).toBe('1月');
    expect(chartTickFormatter(time, TickMarkType.DayOfMonth)).toBe('01-01');
    expect(chartTickFormatter(time, TickMarkType.Time)).toBe('02:02');
    expect(chartTickFormatter(time, TickMarkType.TimeWithSeconds)).toBe('02:02:03');
  });
  it('accepts calendar dates used by the chart library', () => {
    expect(chartTimeFormatter({ year: 2026, month: 10, day: 27 }).slice(0, 10)).toBe('2026-10-27');
    expect(chartTickFormatter('2026-10-27', TickMarkType.DayOfMonth)).toBe('10-27');
  });
  it('retains original candle times, image anchors and fingerprints', () => {
    const candles = SAMPLE_CANDLES.slice(0, 30), before = structuredClone(candles);
    const anchor = chartImageAnchor(candles, 'SNDKUSDT', '1m');
    candles.forEach(candle => formatDisplayTime(candle.timestamp));
    expect(candles).toEqual(before);
    expect(chartImageAnchor(candles, 'SNDKUSDT', '1m')).toEqual(anchor);
  });
  it('preserves the existing image contract while its visible clock changes', () => {
    const candles = SAMPLE_CANDLES.slice(0, 30), image = imageFixture(candles);
    expect(chartImageSchema.parse(image)).toEqual(image);
    expect(() => validateImageAnchors('hybrid', [image], [{ symbol: image.symbol, timeframe: image.timeframe, candles }])).not.toThrow();
    expect(imageManifest([image])[0]).toMatchObject(chartImageAnchor(candles, image.symbol, image.timeframe));
    expect(image.fromTime).toBe(candles[0].timestamp);
    expect(formatDisplayTime(image.fromTime)).not.toBe(new Date(image.fromTime * 1000).toISOString().slice(0,16).replace('T',' '));
    expect(chartImageSchema.safeParse({ ...image, displayTimeZone: 'UTC+9' }).success).toBe(false);
  });
});
