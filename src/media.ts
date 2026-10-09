import { finite, integer, invariant } from './validation.js';
import { encryptAttachment } from './attachments.js';
import type { AttachmentContext } from './attachments.js';
export interface PcmAudio { sampleRate:number;channels:number;samples:Float32Array }
const MAX_MEDIA_BYTES=64*1024*1024;
function validateAudio(audio:PcmAudio):void{
  integer(audio.sampleRate,8000,192000);integer(audio.channels,1,8);
  invariant(audio.samples.length>0&&audio.samples.length%audio.channels===0&&audio.samples.byteLength<=MAX_MEDIA_BYTES,'INVALID_PCM_SHAPE');
  for(const sample of audio.samples)finite(sample,-1,1);
}
export function analyzePcm(audio:PcmAudio){
  validateAudio(audio);const peakByChannel=new Array<number>(audio.channels).fill(0);const energyByChannel=new Array<number>(audio.channels).fill(0);
  for(let i=0;i<audio.samples.length;i++){
    const ch=i%audio.channels;const sample=audio.samples[i]!;
    peakByChannel[ch]=Math.max(peakByChannel[ch]!,Math.abs(sample));energyByChannel[ch]=energyByChannel[ch]!+sample*sample;
  }
  const frames=audio.samples.length/audio.channels;const samplePeak=Math.max(...peakByChannel);
  return{sampleRate:audio.sampleRate,channels:audio.channels,frames,durationSeconds:frames/audio.sampleRate,samplePeak,peakDbFS:samplePeak===0?null:20*Math.log10(samplePeak),rmsByChannel:energyByChannel.map(e=>Math.sqrt(e/frames)),metric:'digital-sample-amplitude' as const};
}
function fourcc(view:DataView,offset:number):string{return String.fromCharCode(...[0,1,2,3].map(i=>view.getUint8(offset+i)));}
/** Endpoint-only RIFF/WAVE parser; compressed/extended formats use future codec adapters. */
export function decodeWave(input:Uint8Array):PcmAudio{
  invariant(input.byteLength>=44&&input.byteLength<=MAX_MEDIA_BYTES,'INVALID_WAVE_SIZE');
  const view=new DataView(input.buffer,input.byteOffset,input.byteLength);
  invariant(fourcc(view,0)==='RIFF'&&fourcc(view,8)==='WAVE'&&view.getUint32(4,true)===input.byteLength-8,'INVALID_WAVE_HEADER');
  let fmt:{format:number;channels:number;sampleRate:number;bits:number;blockAlign:number}|undefined;
  let data:{offset:number;length:number}|undefined;let offset=12;
  while(offset<input.byteLength){
    invariant(offset+8<=input.byteLength,'TRUNCATED_WAVE_CHUNK');
    const tag=fourcc(view,offset);const length=view.getUint32(offset+4,true);const start=offset+8;
    invariant(start+length<=input.byteLength,'TRUNCATED_WAVE_CHUNK');
    if(tag==='fmt '){
      invariant(!fmt&&length>=16,'INVALID_WAVE_FORMAT');
      const format=view.getUint16(start,true);const channels=view.getUint16(start+2,true);const sampleRate=view.getUint32(start+4,true);const blockAlign=view.getUint16(start+12,true);const bits=view.getUint16(start+14,true);
      integer(channels,1,8);integer(sampleRate,8000,192000);
      invariant((format===1&&[16,24,32].includes(bits))||(format===3&&bits===32),'UNSUPPORTED_WAVE_CODEC');
      invariant(blockAlign===channels*(bits/8)&&view.getUint32(start+8,true)===sampleRate*blockAlign,'INVALID_WAVE_ALIGNMENT');
      fmt={format,channels,sampleRate,bits,blockAlign};
    } else if(tag==='data'){invariant(!data,'DUPLICATE_WAVE_DATA');data={offset:start,length};}
    offset=start+length+(length%2);invariant(offset<=input.byteLength,'MISSING_WAVE_PADDING');
  }
  invariant(fmt&&data&&data.length>0&&data.length%fmt.blockAlign===0,'MISSING_OR_MISALIGNED_WAVE_DATA');
  const width=fmt.bits/8;const samples=new Float32Array(data.length/width);
  invariant(samples.byteLength<=MAX_MEDIA_BYTES,'PCM_EXPANSION_LIMIT');
  for(let i=0;i<samples.length;i++){
    const at=data.offset+i*width;let sample:number;
    if(fmt.format===3)sample=view.getFloat32(at,true);
    else if(fmt.bits===16)sample=view.getInt16(at,true)/32768;
    else if(fmt.bits===32)sample=view.getInt32(at,true)/2147483648;
    else{let n=view.getUint8(at)|(view.getUint8(at+1)<<8)|(view.getUint8(at+2)<<16);if(n&0x800000)n-=0x1000000;sample=n/8388608;}
    finite(sample,-1,1);samples[i]=sample;
  }
  return{sampleRate:fmt.sampleRate,channels:fmt.channels,samples};
}
export function encodePcm16(audio:PcmAudio):Uint8Array{
  validateAudio(audio);const dataBytes=audio.samples.length*2;const out=new Uint8Array(44+dataBytes);const v=new DataView(out.buffer);
  const tag=(offset:number,value:string)=>{for(let i=0;i<4;i++)v.setUint8(offset+i,value.charCodeAt(i));};
  tag(0,'RIFF');v.setUint32(4,out.length-8,true);tag(8,'WAVE');tag(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,audio.channels,true);v.setUint32(24,audio.sampleRate,true);v.setUint32(28,audio.sampleRate*audio.channels*2,true);v.setUint16(32,audio.channels*2,true);v.setUint16(34,16,true);tag(36,'data');v.setUint32(40,dataBytes,true);
  for(let i=0;i<audio.samples.length;i++){const s=audio.samples[i]!;v.setInt16(44+i*2,Math.round(s<0?s*32768:s*32767),true);}
  return out;
}
export function validateStemAlignment(stems:readonly PcmAudio[]):void{
  invariant(stems.length>=1&&stems.length<=256,'INVALID_STEM_COUNT');const first=analyzePcm(stems[0]!);
  for(const stem of stems){const m=analyzePcm(stem);invariant(m.sampleRate===first.sampleRate&&m.frames===first.frames,'STEM_ALIGNMENT_MISMATCH');}
}
/** Gain is attenuation only; this helper never raises listener output volume. */
export async function packageRendition(audio:PcmAudio,gain:number,context:AttachmentContext,filename:string){
  validateAudio(audio);finite(gain,0,1);
  const derived:PcmAudio={sampleRate:audio.sampleRate,channels:audio.channels,samples:Float32Array.from(audio.samples,x=>x*gain)};
  const encoded=encodePcm16(derived);const encrypted=await encryptAttachment(encoded,{...context,filename,mediaType:'audio/wav'});
  return{privateMetadata:analyzePcm(decodeWave(encoded)),...encrypted};
}
