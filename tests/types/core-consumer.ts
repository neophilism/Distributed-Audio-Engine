import { EndpointPlaybackSession, compileProgram, EndpointProgramPlayer, ProgramTimeline, CheckoutEngine, ReconciliationEngine, EntitlementLedger, OperationsEvidenceAcceptor, assessOperationsAssurance } from '@neophilism/distributed-audio-engine';
import type { CiphertextChunkTransport } from '@neophilism/distributed-audio-engine';
import { SqliteCheckpointStore, SqliteEntitlementStore } from '@neophilism/distributed-audio-engine/node';
import { OutputEvidenceEndpoint } from '@neophilism/distributed-audio-engine/evidence';
import { OutputLifecycle } from '@neophilism/distributed-audio-engine/output-lifecycle';
import { AndroidAudioSink } from '@neophilism/distributed-audio-engine/android';
import { IOSAudioSink } from '@neophilism/distributed-audio-engine/ios';
const timeline = new ProgramTimeline(0, compileProgram('program', 8000, [{ id: 'clip', assetId: 'asset', frames: 8000, markerAfter: null }]));
declare const transport: CiphertextChunkTransport;
void [EndpointPlaybackSession, timeline, transport, EndpointProgramPlayer, SqliteCheckpointStore, SqliteEntitlementStore, CheckoutEngine, ReconciliationEngine, EntitlementLedger, OperationsEvidenceAcceptor, assessOperationsAssurance, OutputEvidenceEndpoint, OutputLifecycle, AndroidAudioSink, IOSAudioSink];

import { convertPcmFormat, packageNormalizedRendition, EncryptedLivePcmSegmenter, LiveSegmentContinuity, describeLiveSegment, BoundedLiveNoticeReorder } from '@neophilism/distributed-audio-engine';
import type { PcmAudio, PcmFormatTarget, PcmConversionOptions } from '@neophilism/distributed-audio-engine';
declare const sourcePcm: PcmAudio, formatTarget: PcmFormatTarget, conversionOptions: PcmConversionOptions;
void convertPcmFormat(sourcePcm, formatTarget, conversionOptions);
void packageNormalizedRendition(sourcePcm, formatTarget, 0.5,
  { tenantId: 'tenant', application: 'distributed-radio', parentMessageId: 'parent' }, 'normalized.wav');
const live = new EncryptedLivePcmSegmenter({
  scope: { tenantId: 'tenant', application: 'distributed-radio', sessionId: 'live' },
  streamId: 'publisher', sampleRate: 8000, channels: 1, segmentFrames: 800, gain: 0.5,
});
void live.push(0n, new Float32Array(800)); void live.flush();
void [LiveSegmentContinuity, describeLiveSegment, BoundedLiveNoticeReorder];
// @ts-expect-error The source frame cursor must be a bigint, not a guessed number.
void live.push(0, new Float32Array(800));
// @ts-expect-error Implicit string formats are not accepted by the converter.
void convertPcmFormat(sourcePcm, 'stereo');
