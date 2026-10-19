import Papa from 'papaparse';

/** UTC Unix seconds are the single time representation used by the API and chart. */
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const MAX_CANDLES = 2_000;
export const MAX_ANALYSIS_CANDLES = 300;
export const MIN_CANDLES = 10;
const MAX_TIMESTAMP = 4_102_444_800; // 2100-01-01 UTC
const MAX_PRICE = 1_000_000_000_000;
const COLUMNS = ['timestamp', 'open', 'high', 'low', 'close', 'volume'] as const;
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const ZONED_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i;

function readTimestamp(raw: string, row: number): number {
  let timestamp: number;
  if (NUMBER_PATTERN.test(raw)) {
    const numeric = Number(raw);
    timestamp = numeric >= 100_000_000_000 ? numeric / 1_000 : numeric;
  } else if (ZONED_ISO_PATTERN.test(raw)) {
    // Reject calendar normalization (for example February 30) as well as invalid dates.
    const datePart = raw.slice(0, 10);
    const [year, month, day] = datePart.split('-').map(Number);
    const [hours, minutes, seconds] = raw.slice(11, 19).split(':').map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hours > 23 || minutes > 59 || seconds > 59) {
      throw new Error(`第 ${row} 行 timestamp 的日期无效。`);
    }
    timestamp = Date.parse(raw) / 1_000;
  } else {
    throw new Error(`第 ${row} 行 timestamp 须为 Unix 秒/毫秒，或带时区的 ISO 时间（例如 2026-10-10T00:00:00Z）。`);
  }
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
    throw new Error(`第 ${row} 行 timestamp 无效，时间须在 1970–2100 年之间并精确到整秒。`);
  }
  return timestamp;
}

/** Validate an API payload without coercion, sorting, deduplication, or interpolation. */
export function validateCandles(input: unknown): Candle[] {
  if (!Array.isArray(input) || input.length < MIN_CANDLES || input.length > MAX_CANDLES) {
    throw new Error(`行情数据须包含 ${MIN_CANDLES}–${MAX_CANDLES} 根 K 线。`);
  }
  let previousTimestamp = -1;
  return input.map((value: unknown, index): Candle => {
    const row = index + 2;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`第 ${row} 行不是有效的行情记录。`);
    }
    const record = value as Record<string, unknown>;
    for (const column of COLUMNS) {
      const number = record[column];
      if (typeof number !== 'number' || !Number.isFinite(number)) {
        throw new Error(`第 ${row} 行 ${column} 缺失或不是有限数值。`);
      }
    }
    const candle = Object.fromEntries(COLUMNS.map((column) => [column, record[column]])) as unknown as Candle;
    if (!Number.isInteger(candle.timestamp) || candle.timestamp < 0 || candle.timestamp > MAX_TIMESTAMP) {
      throw new Error(`第 ${row} 行 timestamp 须为有效的 UTC Unix 整秒。`);
    }
    if (candle.timestamp <= previousTimestamp) {
      throw new Error(`第 ${row} 行时间重复或未严格递增；请按时间升序提供数据。`);
    }
    previousTimestamp = candle.timestamp;
    for (const column of ['open', 'high', 'low', 'close'] as const) {
      if (candle[column] <= 0 || candle[column] > MAX_PRICE) {
        throw new Error(`第 ${row} 行 ${column} 须大于 0 且不超过 ${MAX_PRICE}。`);
      }
    }
    if (candle.volume < 0 || candle.volume > Number.MAX_SAFE_INTEGER) {
      throw new Error(`第 ${row} 行 volume 须为非负且在安全数值范围内。`);
    }
    if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close, candle.high)) {
      throw new Error(`第 ${row} 行 OHLC 不一致：high 须为最高价，low 须为最低价。`);
    }
    return candle;
  });
}

export function parseMarketCsv(text: string): { candles: Candle[]; warnings: string[] } {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('CSV 文件为空。');
  // Skip blank physical lines only; a six-cell all-missing record must be rejected.
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { delimiter: ',', skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`CSV 格式无效：${parsed.errors[0].message}`);
  const [header, ...rows] = parsed.data;
  if (!header) throw new Error('CSV 缺少表头。');
  const columns = header.map((column) => column.trim().toLowerCase());
  if (new Set(columns).size !== columns.length) throw new Error('CSV 表头包含重复列。');
  const missing = COLUMNS.filter((column) => !columns.includes(column));
  if (missing.length) throw new Error(`CSV 缺少必要列：${missing.join('、')}。`);
  if (rows.length < MIN_CANDLES || rows.length > MAX_CANDLES) {
    throw new Error(`行情数据须包含 ${MIN_CANDLES}–${MAX_CANDLES} 根 K 线。`);
  }
  const positions = COLUMNS.map((column) => columns.indexOf(column));
  const input = rows.map((cells, index) => {
    const row = index + 2;
    if (cells.length !== columns.length) throw new Error(`第 ${row} 行列数与表头不一致。`);
    const values = positions.map((position) => cells[position]?.trim() ?? '');
    if (values.some((value) => value === '')) throw new Error(`第 ${row} 行有缺失值；不会自动填充缺失行情。`);
    const record: Record<string, number> = { timestamp: readTimestamp(values[0], row) };
    COLUMNS.slice(1).forEach((column, offset) => {
      const raw = values[offset + 1];
      if (!NUMBER_PATTERN.test(raw)) throw new Error(`第 ${row} 行 ${column} 不是有效数值。`);
      record[column] = Number(raw);
    });
    return record;
  });
  const candles = validateCandles(input);
  const intervals = new Set(candles.slice(1).map((candle, index) => candle.timestamp - candles[index].timestamp));
  const warnings: string[] = [];
  if (intervals.size > 1) warnings.push('K 线时间间隔不一致，可能存在休市或数据缺口；已保留原始时间，不补齐或插值。');
  const extra = columns.filter((column) => !COLUMNS.includes(column as typeof COLUMNS[number]));
  if (extra.length) warnings.push(`已忽略额外列：${extra.join('、')}。`);
  return { candles, warnings };
}

export function candlesToCsv(candles: Candle[]): string {
  return [COLUMNS.join(','), ...candles.map((candle) => [new Date(candle.timestamp * 1_000).toISOString(), candle.open, candle.high, candle.low, candle.close, candle.volume].join(','))].join('\n');
}
