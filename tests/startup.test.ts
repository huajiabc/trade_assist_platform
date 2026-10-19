import { describe, expect, it } from 'vitest';
import { resolveStartup } from '../src/startup';

const defaultQuery = { symbol: 'SNDKUSDT', interval: '5m', limit: 300 };

describe('startup market selection', () => {
  it('opens SNDKUSDT 5m exchange data by default', () => {
    expect(resolveStartup('')).toEqual({ mode: 'live', query: defaultQuery });
    expect(resolveStartup('?')).toEqual({ mode: 'live', query: defaultQuery });
  });

  it('requires an explicit supported demo query for synthetic data', () => {
    expect(resolveStartup('?demo=smc')).toEqual({ mode: 'demo', demo: 'smc' });
    expect(resolveStartup('?demo=pa')).toEqual({ mode: 'demo', demo: 'pa' });
    expect(resolveStartup('?demo=other')).toMatchObject({ mode: 'live', query: defaultQuery });
  });

  it('gives an explicit live market precedence over a demo query', () => {
    expect(resolveStartup('?demo=pa&live=ethusdt&interval=15m')).toEqual({
      mode: 'live', query: { symbol: 'ETHUSDT', interval: '15m', limit: 300 },
    });
    expect(resolveStartup('?demo=smc&live=SNDKUSDT')).toEqual({ mode: 'live', query: defaultQuery });
  });

  it('keeps an interval-only link on the real default symbol', () => {
    expect(resolveStartup('?interval=4h')).toEqual({ mode: 'live', query: { ...defaultQuery, interval: '4h' } });
  });

  it.each(['?live=', '?live=BTC', '?live=../../../secret', '?live=SNDKUSDT&interval=1s', '?demo=pa&live=INVALID'])('rejects malformed live parameters without switching to synthetic data: %s', search => {
    const startup = resolveStartup(search);
    expect(startup).toMatchObject({ mode: 'live', query: defaultQuery, error: expect.any(String) });
    if (startup.mode === 'live') expect(startup.error?.length).toBeGreaterThan(0);
  });
});
