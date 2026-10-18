# Authenticated live segment continuity (DAE-29 receiver software increment)

The portable `describeLiveSegment` function turns one completed
`EncryptedLivePcmSegmenter` output into **JSON-safe metadata** for the
existing authenticated E2EE parent channel. It never includes plaintext,
a media key, ciphertext, relay identifiers, or a private manifest.

After the receiver authenticates that notice and its private manifest
through the enrolled Signal parent, confirms current rights and recipient
membership, downloads and decrypts the matching ciphertext, and verifies
decoded media geometry, use `LiveSegmentContinuity` to enforce **strict
stream and frame order**:

```ts
import {
  describeLiveSegment, LiveSegmentContinuity,
} from '@neophilism/distributed-audio-engine';

// Publisher: send this notice alongside the matching PRIVATE manifest over
// the existing authorized E2EE channel, not via an unauthenticated relay.
const notice = describeLiveSegment(encryptedSegment);

// Receiver: obtain the expected captureId from authenticated app state.
// Create one validator for the explicit, current capture incarnation.
const continuity = new LiveSegmentContinuity({
  captureId: trustedCaptureId,
  sampleRate: trustedSampleRate,
  channels: trustedChannels,
  initialFrame: 0n,
});

// IMPORTANT: before accept, independently verify the authenticated notice,
// media rights/expiry, manifest context, decoded sample rate/channels/frames,
// route compatibility and current output lease in the consuming application.
const accepted = continuity.accept(authenticatedNotice);
// Only then schedule frames through the existing signed/authorized player.
```

`startFrameDecimal` uses canonical unsigned decimal characters so it can
cross JSON/E2EE boundaries without JavaScript BigInt serialization. It is
bounded to unsigned 64-bit source frames. A notice binds
`captureId`, `parentMessageId`, `segmentIndex`, `sampleRate`,
`channels`, `frames` and `startFrameDecimal`. The capture ID includes a
fresh producer-side incarnation UUID; the receiver **must** pin the expected
one through authenticated current membership, not infer authorization from
the first relay packet or this geometry verifier.

A valid notice must reference the exact next expected segment number and
source frame. Duplicates, missing frames, out-of-order frames, wrong capture,
layout changes, impossible counts, injected properties and noncanonical
numbers reject without advancing the cursor. The application can wait for
an earlier authenticated segment then retry; neither missing frames nor
clock corrections are silently invented. Close this validator on revocation,
route invalidation, explicit user stop or an unrecoverable gap.

This is a **volatile metadata sequence gate**, not a persistent anti-replay
journal. Durable replay resistance remains with the authenticated parent
channel, signed control checkpoints and application storage. It is not a
decoder, renderer, network jitter buffer, live transport, clock correction
system, acoustic calibration, or a production-ready streaming release.
No listener data, hardware measurements or E2EESA certification are claimed.
