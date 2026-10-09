import { compileProgram, EndpointProgramPlayer, ProgramTimeline } from '@neophilism/distributed-audio-engine';
import type { CiphertextChunkTransport } from '@neophilism/distributed-audio-engine';
import { SqliteCheckpointStore } from '@neophilism/distributed-audio-engine/node';
const timeline = new ProgramTimeline(0, compileProgram('program', 8000, [{ id: 'clip', assetId: 'asset', frames: 8000, markerAfter: null }]));
declare const transport: CiphertextChunkTransport;
void [timeline, transport, EndpointProgramPlayer, SqliteCheckpointStore];
