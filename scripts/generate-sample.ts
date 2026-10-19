import { mkdir, writeFile } from 'node:fs/promises';
import { SAMPLE_CANDLES } from '../shared/sample';
import { PA_SAMPLE_CANDLES } from '../shared/paSample';
import { candlesToCsv } from '../shared/market';

await mkdir(new URL('../public/', import.meta.url), { recursive: true });
await writeFile(new URL('../public/sample-ohlcv.csv', import.meta.url), candlesToCsv(SAMPLE_CANDLES) + '\n', 'utf8');
console.log(`Generated ${SAMPLE_CANDLES.length} synthetic candles in public/sample-ohlcv.csv`);
await writeFile(new URL('../public/pa-example.csv', import.meta.url), candlesToCsv(PA_SAMPLE_CANDLES) + '\n', 'utf8');
console.log(`Generated ${PA_SAMPLE_CANDLES.length} PA teaching candles in public/pa-example.csv`);
