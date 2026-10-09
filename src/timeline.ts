import { canonicalJson, identifier, integer, invariant } from './validation.js';
export interface AudioClip {id:string;assetId:string;frames:number;markerAfter:string|null}
export interface AudioProgram {id:string;sampleRate:number;clips:readonly AudioClip[];totalFrames:number}
export function compileProgram(id:string,sampleRate:number,clips:readonly AudioClip[]):AudioProgram{
  identifier(id);integer(sampleRate,8000,192000);invariant(clips.length>0&&clips.length<=4096,'INVALID_PROGRAM_SIZE');
  const local=structuredClone(clips);const ids=new Set<string>();let totalFrames=0;
  for(const clip of local){
    invariant(Object.keys(clip).sort().join(',')==='assetId,frames,id,markerAfter','UNKNOWN_CLIP_FIELDS');
    identifier(clip.id);identifier(clip.assetId);integer(clip.frames,1);
    invariant(!ids.has(clip.id),'DUPLICATE_CLIP_ID');ids.add(clip.id);if(clip.markerAfter!==null)identifier(clip.markerAfter);
    totalFrames+=clip.frames;integer(totalFrames,1);
  }
  return{id,sampleRate,clips:local,totalFrames};
}
function validProgram(program:AudioProgram):AudioProgram{
  const rebuilt=compileProgram(program.id,program.sampleRate,program.clips);
  invariant(program.totalFrames===rebuilt.totalFrames,'PROGRAM_DURATION_MISMATCH');return rebuilt;
}
export function resolveFrame(program:AudioProgram,elapsedFrames:bigint){
  invariant(elapsedFrames>=0n,'PROGRAM_NOT_STARTED');const local=validProgram(program);
  const loopIndex=elapsedFrames/BigInt(local.totalFrames);const inLoop=Number(elapsedFrames%BigInt(local.totalFrames));
  let start=0;
  for(const clip of local.clips){
    if(inLoop<start+clip.frames)return{programId:local.id,clipId:clip.id,assetId:clip.assetId,offsetFrames:inLoop-start,loopIndex,sampleRate:local.sampleRate};
    start+=clip.frames;
  }
  throw new Error('Unreachable validated timeline position');
}
/** Scheduling only: actual output alignment requires native clock/latency qualification. */
export class ProgramTimeline {
  private readonly revisions:{startFrame:bigint;program:AudioProgram}[];
  private readonly sampleRate:number;
  constructor(private readonly epochUnixMs:number,initial:AudioProgram){
    integer(epochUnixMs);const program=validProgram(initial);this.sampleRate=program.sampleRate;this.revisions=[{startFrame:0n,program}];
  }
  frameAt(unixMs:number):bigint{
    integer(unixMs);invariant(unixMs>=this.epochUnixMs,'PROGRAM_NOT_STARTED');
    return(BigInt(unixMs)-BigInt(this.epochUnixMs))*BigInt(this.sampleRate)/1000n;
  }
  publish(next:AudioProgram,effectiveFrame:bigint,nowUnixMs:number):void{
    const program=validProgram(next);invariant(program.sampleRate===this.sampleRate,'PROGRAM_RATE_CHANGE');
    invariant(effectiveFrame>this.frameAt(nowUnixMs),'REVISION_NOT_FUTURE');
    const previous=this.revisions.at(-1)!;
    invariant(effectiveFrame>previous.startFrame&&(effectiveFrame-previous.startFrame)%BigInt(previous.program.totalFrames)===0n,'REVISION_NOT_LOOP_BOUNDARY');
    invariant(!this.revisions.some(r=>r.program.id===program.id),'PROGRAM_REVISION_ID_REUSE');
    this.revisions.push({startFrame:effectiveFrame,program});
  }
  targetAt(unixMs:number){
    const frame=this.frameAt(unixMs);let revision=this.revisions[0]!;
    for(const candidate of this.revisions){if(candidate.startFrame>frame)break;revision=candidate;}
    return{...resolveFrame(revision.program,frame-revision.startFrame),absoluteFrame:frame,alignment:'timeline-only' as const};
  }
  /** Exact discrete marker instants, bounded to avoid massive historical replay. */
  markersBetween(afterFrame:bigint,throughFrame:bigint,maxMarkers=1024){
    invariant(afterFrame>=-1n&&throughFrame>=afterFrame,'INVALID_MARKER_RANGE');integer(maxMarkers,1,4096);
    const result:{id:string;atFrame:bigint;programId:string;clipId:string}[]=[];
    for(let r=0;r<this.revisions.length;r++){
      const revision=this.revisions[r]!;const end=this.revisions[r+1]?.startFrame;
      if(revision.startFrame>throughFrame)break;
      if(end!==undefined&&afterFrame>=end)continue;
      const loop=BigInt(revision.program.totalFrames);
      const from=afterFrame>revision.startFrame?afterFrame-revision.startFrame:0n;
      const limit=end!==undefined&&end<throughFrame?end:throughFrame;
      const first=from/loop;const last=(limit-revision.startFrame)/loop;
      invariant(last-first<=BigInt(maxMarkers),'MARKER_REPLAY_RANGE_TOO_LARGE');
      for(let cycle=first;cycle<=last;cycle++){
        let position=0;
        for(const clip of revision.program.clips){
          position+=clip.frames;const atFrame=revision.startFrame+cycle*loop+BigInt(position);
          // The closing marker at a revision boundary belongs to the old clip.
          if(clip.markerAfter&&atFrame>afterFrame&&atFrame<=throughFrame&&(!end||atFrame<=end)){
            invariant(result.length<maxMarkers,'TOO_MANY_MARKERS');result.push({id:clip.markerAfter,atFrame,programId:revision.program.id,clipId:clip.id});
          }
        }
      }
    }
    return result.sort((a,b)=>a.atFrame<b.atFrame?-1:a.atFrame>b.atFrame?1:a.id<b.id?-1:a.id>b.id?1:0);
  }
}
