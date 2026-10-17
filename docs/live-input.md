# Bounded encrypted live PCM segmentation (DAE-29 software increment)

`EncryptedLivePcmSegmenter` is an **endpoint-only, foreground capture
preparation primitive**. It takes PCM supplied by an already authorized local
application and packages short, contiguous chunks as independently encrypted
WAVE media. It does not request microphone permission, capture audio, publish a
live show, schedule receivers, create a peer group, or start a network service.
The existing E2E attachment profile and per-segment fresh keys are reused; no
new cryptography or server-side transcoding was introduced.

```ts
import { EncryptedLivePcmSegmenter } from '@neophilism/distributed-audio-engine';

const stream = new EncryptedLivePcmSegmenter({
  scope: { tenantId: 'tenant', application: 'distributed-radio', sessionId: 'session' },
  streamId: 'unique-capture-id',
  sampleRate: 48000,
  channels: 2,
  segmentFrames: 4800, // 100 ms at 48 kHz
  gain: 0.75,           // attenuation only
});
const encrypted = await stream.push(0n, localAuthorizedFloat32Pcm);
for (const segment of encrypted) {
  // Use segment.ciphertextChunks ONLY for the authorized ciphertext relay.
  // Send segment.privateManifest and private metadata via authenticated E2EE
  // parent delivery, with current permissions/expiry and a suitable timeline.
}
const last = await stream.flush(); // one final short segment or null
```

## Source and ordering contract

Each `push(frameStart, samples, signal?)` accepts a bounded Float32Array of
interleaved PCM at the declared fixed sample rate and channel count. `frameStart`
must equal the exact next source frame (a bigint). Repeated, missing or out-of-order
frames are rejected without silently inserting silence, repeating frames, or
resetting clock epochs. A local caller may correct a rejected, not-yet-consumed
input by resubmitting at the expected frame; lost input requires a new stream
under explicit application policy. All sample values must be finite and within
[-1, 1]. No implicit gain boost or native format conversion is performed.

A stream buffers at most one segment internally. Each push accepts at most four
segments' worth of frames; callers must await the result before pushing again,
providing bounded explicit backpressure. One segment occupies at most 2 MiB
of Float32 samples, contains at most one second of audio, and uses up to eight
channels at rates between 8 and 192 kHz. Segment sequence numbers are bounded
to one million per stream. Each output includes its frame start and exact frame
count, new attachment key, unique storage identifier and a distinct
`parentMessageId` derived from the capture's unique `streamId`.
The caller MUST select a fresh `streamId` for each independently created capture
and preserve order for its downstream timeline; no global ID registry is provided.

Segments are PCM16 WAVE renditions via the existing `packageRendition`
encoder. Quantization is expected. `flush()` encrypts an unpadded short
tail and permanently closes the stream. `close()` wipes the internal PCM
buffer and refuses further calls; it cannot recall ciphertext already
returned to the application. Input is synchronously copied before encryption,
so later caller mutation cannot change a committed segment. A failed batch
withholds and wipes its owned previously generated chunk results and closes
the segmenter rather than silently advancing a damaged stream.

## Security and deployment boundaries

Media plaintext and private manifests must remain at the authorized
publisher/recipient endpoint. Never send `privateManifest`, derived
`privateMetadata`, PCM, attachment keys or other user-private fields to the
ciphertext-only relay. The application supplies current root-verified device
membership, signed playback authority, permissions, authenticated parent
manifest delivery, bounded network retries, and lifecycle cancellation.
Cancellation can withhold an encrypted result but cannot forcibly stop a
platform Web Crypto call that is already in progress. Memory erasure covers
owned buffers but not runtime/GC copies or swap.

This module is **not real-time audio processing**: WAVE encoding/encryption
runs outside any real-time audio callback. It does not maintain history across
rate conversion windows, compensate source/receiver drift, conceal jitter,
align speakers, guarantee low latency, or offer a background capture service.
An application needs an external capture ring/worker, explicit queue policies,
transmission/backpressure and dynamic program timeline for live streaming.
No hardware, acoustic, mobile runtime, live codec, physical-speaker,
independent-review or production deployment status is promoted by these
software tests.

`tests/live-input.test.ts` covers contiguous segment boundaries, encrypted
round trips, fresh per-segment manifests, partial flush, mutation resistance,
invalid/gapped/replayed inputs, bounded producer calls, concurrency and
closure/cancellation. Hosted `npm run check` and the integration rehearsal
remain separate release gates.
