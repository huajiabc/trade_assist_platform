import { chartImageSchema, MAX_CHART_IMAGE_BYTES, type ChartImage } from '../shared/analysisInput';
/** Only bounded inline PNGs; no client paths or remote image fetching. Pixels remain untrusted model context. */
export function chartImageBytes(raw:ChartImage):Buffer{
 const image=chartImageSchema.parse(raw),bytes=Buffer.from(image.base64,'base64');
 if(bytes.length>MAX_CHART_IMAGE_BYTES||bytes.toString('base64')!==image.base64||bytes.length<33||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==image.width||bytes.readUInt32BE(20)!==image.height)throw new Error('图表PNG格式或尺寸无效。');
 return bytes;
}
