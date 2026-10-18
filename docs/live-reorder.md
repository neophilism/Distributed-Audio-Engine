# Bounded authenticated live notice reordering

`BoundedLiveNoticeReorder` is a small, portable, **metadata-only** receiver
buffer built on `LiveSegmentContinuity`. It permits bounded out-of-order
delivery of already authenticated live segment notices, releasing only a
contiguous prefix. It is not an audio-data jitter buffer or playout clock.

```ts
import { BoundedLiveNoticeReorder } from '@neophilism/distributed-audio-engine';

const inbox = new BoundedLiveNoticeReorder({
  captureId: trustedCaptureId,
  sampleRate: trustedRate,
  channels: trustedChannels,
  maxBufferedNotices: 8,
});

for (const notice of authenticatedAndMediaVerifiedNotices) {
  const ready = inbox.offer(notice);
  for (const segment of ready) {
    // The app now schedules this already authenticated/decrypted segment
    // only while rights and an explicit signed playback lease remain valid.
  }
}
inbox.close(); // route, membership, authority or session invalidated
```

**The caller must first** authenticate the notice and private manifest through
the enrolled E2EE parent; authorize the current source/recipient, check
rights/expiry, fetch AEAD ciphertext and verify decoded audio geometry. The
reorder queue does none of those steps and cannot grant playback authority.
Never ingest unauthenticated relay metadata or keys into this queue.

At most 64 future notices may be buffered, configurable down to one. Every
offer requires the exact authorized capture and media layout, a canonical
bounded decimal source frame and a sequence number within the forward window.
Repeated/past notices and duplicate pending indexes reject without advancing
state. Out-of-order future items remain copied into bounded owned memory;
the input object cannot alter them afterward. The window preflights every
releasable contiguous item **before** advancing the timeline, so a malicious
or corrupted future frame does not partially advance earlier positions.
A gap must be resolved by correctly authenticated retransmission, explicit
session termination or a higher-level application policy: no synthesized
silence, seek, implicit restart or silent clock correction is permitted.

No real media samples, private attachment manifests, nonce secrets, keys,
ciphertext, user recordings or audio timing data are retained by this
metadata-only component. Buffered entries are discarded on close. It is
volatile and cannot replace the durable Signal journal or signed control
checkpoints after a crash. It does not adapt sample rates, compensate clock
drift, measure audible output, or provide a native mobile runtime/streaming
receiver. Tests are portable software evidence only.
