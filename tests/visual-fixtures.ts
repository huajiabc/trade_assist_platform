import { deflateSync } from 'node:zlib';
import { chartImageAnchor, type ChartImage } from '../shared/analysisInput';
import type { Candle } from '../shared/market';
function crc(bytes:Buffer){let x=0xffffffff;for(const b of bytes){x^=b;for(let i=0;i<8;i++)x=(x>>>1)^((x&1)?0xedb88320:0);}return (x^0xffffffff)>>>0;}
const chunk=(type:string,data:Buffer)=>{const head=Buffer.from(type),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([head,data])));return Buffer.concat([size,head,data,sum]);};
/** Valid flat PNG for contract tests only; not a market rendering or performance benchmark. */
export function imageFixture(candles:Candle[],symbol='SNDKUSDT',timeframe='1m'):ChartImage{
 const header=Buffer.alloc(13);header.writeUInt32BE(1280);header.writeUInt32BE(600,4);header[8]=8;header[9]=2;
 const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((1280*3+1)*600))),chunk('IEND',Buffer.alloc(0))]);
 return {...chartImageAnchor(candles,symbol,timeframe),width:1280,height:600,base64:png.toString('base64')};
}
