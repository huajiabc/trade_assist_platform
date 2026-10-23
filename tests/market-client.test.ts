import {afterEach,describe,expect,it,vi} from 'vitest';
import {getMarketCandles,MarketRequestError} from '../src/services/market';
const query={symbol:'SNDKUSDT',interval:'1m' as const,limit:20};
afterEach(()=>vi.unstubAllGlobals());
describe('market client failures and initial retry classification',()=>{
 it.each([408,429,500,502,503,504])('preserves retryable HTTP%s and safe server message',async status=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{message:'upstream unavailable'}}),{status})));
  const error=await getMarketCandles(query,new AbortController().signal).catch(e=>e);expect(error).toBeInstanceOf(MarketRequestError);expect(error.status).toBe(status);expect(error.retryable).toBe(true);expect(error.message).toBe('upstream unavailable');
 });
 it.each([400,401,403,404])('does not automatically retry permanent HTTP%s',async status=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{message:'invalid request'}}),{status})));
  const error=await getMarketCandles(query,new AbortController().signal).catch(e=>e);expect(error.retryable).toBe(false);
 });
 it('preserves a network failure as a retryable transport TypeError',async()=>{
  const error=new TypeError('network unavailable');vi.stubGlobal('fetch',vi.fn(async()=>{throw error;}));await expect(getMarketCandles(query,new AbortController().signal)).rejects.toBe(error);
 });
 it('rejects invalid successful data without classifying it as a transient HTTP outage',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({candles:[]}),{status:200})));const error=await getMarketCandles(query,new AbortController().signal).catch(e=>e);expect(error).not.toBeInstanceOf(MarketRequestError);
 });
});
