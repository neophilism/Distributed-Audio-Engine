# Endpoint PCM format preparation

`convertPcmFormat` and `packageNormalizedRendition` add explicit, bounded offline
sample-rate and channel conversion at the authorized publishing endpoint. They
make common source formats usable with a selected native/program format rather
than silently ignoring the native sink's rate requirement. Neither function runs
at the ciphertext relay, changes an OS volume, corrects live clock drift, guesses
a spatial speaker layout, or qualifies a physical audio route.

```ts
const packaged = await packageNormalizedRendition(
  sourcePcm,
  { sampleRate: 48000, channels: 2 },
  0.8,
  { tenantId, application: 'distributed-radio', parentMessageId },
  'prepared.wav',
  { signal: abortController.signal },
);
// Upload only packaged.ciphertextChunks.
// Deliver packaged.privateManifest and the private metadata through the existing
// authenticated endpoint channel, with current recipient and media rights.
```

Use `packaged.privateMetadata.sampleRate`, `channels` and `frames` for the private
asset descriptor and the matching program timeline. Do not reuse the original
source frame count after conversion. All clips in one existing `ProgramTimeline`
still use its canonical rate. The native sink retains its explicit rate/layout
checks; this helper is not an automatic fallback or a new playback authorization.
Different renditions receive fresh keys and storage identities. The source audio
and target channel map are snapshotted before the first asynchronous yield.

## Channel policy

Equal channel counts default to a per-channel identity map. Mono to stereo
explicitly duplicates the source; stereo to mono averages the two channels. A
conversion involving another layout requires a supplied output-row/input-column
`channelMatrix`. Coefficients must be finite, each between -1 and 1, with an
absolute sum no greater than 1 in each row. This prevents an uncontrolled sum of
full-scale inputs. It does not infer speaker semantics, physical acoustic energy
or a surround-channel convention from the channel count.

## Rate conversion and sample peaks

Equal sample rates bypass filtering. Other supported integer ratios use a finite
Blackman-windowed sinc, normalized per rational phase for constant-signal gain.
The normalized cutoff is `0.9 * min(1, outputRate / inputRate)` relative to the
input Nyquist frequency. The radius is `ceil(32 / cutoff)` input samples. At each
output position the implementation evaluates one precomputed rational phase;
there is no accumulated floating-point phase increment. The final output frame
count is `max(1, round(inputFrames * outputRate / inputRate))`.

The general reason for low-pass filtering before downsampling and finite-window
interpolation is described in Julius O. Smith's *Physical Audio Signal Processing*,
[Windowed Sinc Interpolation](https://www.dsprelated.com/freebooks/pasp/Windowed_Sinc_Interpolation.html).
This implementation has its own finite window and resource policy; it does not
claim ideal reconstruction or the book's illustrative filter performance.

A filter can overshoot between source samples. The converter computes the output
sample peak and, only if necessary, applies one **uniform attenuation** so that it
never exceeds the original source sample peak. It does not normalize upward or
independently clip ordinary filter samples. `conversion.peakAttenuation` reports
that factor, including any boundary-driven attenuation. The final numerical clamp
only bounds rounding to the same original peak. This is a digital-sample measure,
not true-peak loudness, speaker sound pressure or a listener volume setting.

The finite input is extended constantly at either edge. This makes one-file edge
behavior deterministic, but is not a continuous streaming resampler. Do not split
one continuous signal into independently converted adjacent pieces and claim
seamless boundary equivalence. Whole bounded assets are the current supported
unit; streaming history/overlap and live drift adaptation remain separate work.
The reported duration error is at most one output sample under the nonempty-file
rule, not an assertion of physical synchronization.

## Explicit limits and cancellation

Input and output rates are integers from 8,000 through 192,000 Hz, with one through
eight channels. Source PCM and output PCM are each bounded to 64 MiB. The optional
`maxOutputBytes` can only tighten the output cap. These are individual-buffer
limits, not a total process-memory guarantee: conversion and encryption need
additional owned buffers. The rational phase count is at most 2,048 and the
coefficient table at most 1,048,576 doubles. An unsupported costly ratio is rejected
explicitly. Common 8/16/22.05/24/32/44.1/48/88.2/96/176.4/192 kHz inputs are tested
against 8/44.1/48 kHz outputs.

A conservative operation estimate must fit `maxOperations` (250 million by
default; never over one billion). Resource checks precede the owned sample copies
and output allocation. The operation estimate is a computational budget, not a
wall-clock deadline or a real-time callback guarantee. Large assets may require
an explicit larger bounded budget or a future streaming adapter; rejection never
silently drops samples, chooses a cheaper filter or changes the requested format.

Work yields in bounded batches and checks `AbortSignal`. Failure/cancellation
clears the owned input and partial output; successful output belongs to the caller.
`packageNormalizedRendition` clears the converted PCM after packaging and withholds
its result if cancellation occurs during native encryption. Native Web Crypto
cannot be forcibly cancelled. These are owned-buffer lifetime controls, not a
claim of secure erasure of JavaScript strings, garbage-collector copies or swap.

## Verification boundaries

Nineteen focused portable cases cover exact frame geometry, mono/stereo and
explicit matrices, common rates, DC, interior low-frequency amplitude/phase,
7 kHz alias rejection on 48-to-8 kHz conversion, full-scale ringing attenuation,
silence/one-frame input, budgets before allocation, malformed input, caller mutation,
cancellation and real encrypted WAVE round trips. Spectral limits apply to those
fixtures, not every possible signal. Two additional signed JavaScript-to-production-C
cases and two actual Signal/TLS-to-production-C cases exercise endpoint conversion
from 44.1 kHz mono to the native test format. The C renderer is real; test routes,
clocks and device state are synthetic, not actual phones or physical speakers.

All existing checks and the complete hosted rehearsal remain required before
merge. The helper introduces no dependency, paid provider, credential requirement,
cloud deployment, mobile runtime or independent audit claim.
