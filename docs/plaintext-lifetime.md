# Endpoint-owned plaintext lifetime and allocation bounds

This increment tightens the existing attachment and PCM path. It changes neither
AES-GCM, the attachment profile, key establishment nor the relay trust boundary.
Protected audio is still decoded only at an authorized endpoint after actual
manifest/channel authentication and media integrity verification.

## Owned copies versus caller-owned results

`encryptAttachment` snapshots ordinary endpoint-owned input before asynchronous
work. Its owned full input, temporary plaintext chunks and imported raw key bytes
are overwritten on success and failure, including hashing/import/encryption
rejection. Temporary random byte arrays are overwritten after conversion to the
private manifest representation. The successful private manifest intentionally
contains the key required by its authorized recipient; the caller must deliver
it only through the existing authenticated endpoint channel.

`decryptAttachment` checks manifest geometry and declared limits before copying
ciphertext. It authenticates the manifest, imports a non-extractable key, and
clears each decrypted intermediate after copying into the final output. A failed
chunk or whole-file hash wipes the partial final output. A successful final
plaintext buffer belongs to the caller and is not silently wiped. Caller-owned
source buffers, ciphertext and private manifests are never mutated by cleanup.

Range readers clear imported raw bytes and copied key strings; closing drops the
reader's key reference. Native crypto work already in flight cannot be forcibly
cancelled. If it finishes after close, its returned plaintext is wiped and never
released. This does not claim that JavaScript strings, garbage-collector copies,
provider-internal key storage, swap or operating-system crash dumps are erased.
These are best-effort lifetime reductions for buffers the implementation owns,
not hardware zeroization or physical secure-erasure certification.

## PCM and WAVE boundaries

WAVE decoded size is checked **before** allocating its Float32 sample buffer,
including PCM16 expansion beyond the 64 MiB limit. Invalid/nonfinite samples wipe
partially decoded PCM before rejection. `packageRendition` clears its temporary
derived PCM, encoded WAVE and metadata-decoding buffers even if encryption fails.
It never changes the original input samples or increases the requested gain.

SharedArrayBuffer-backed plaintext, WAVE and PCM are rejected: a writer in another
thread could change data while it is being validated/copied. Pass an explicitly
owned ordinary ArrayBuffer snapshot from the authorized endpoint instead. The
existing in-process APIs do not provide a concurrent shared-memory capture protocol.

## Reproduced verification

Twelve focused tests use actual Web Crypto with instrumented buffer observation,
plus injected provider failures, malformed geometry, oversized decode claims and
late reader completion. The initial implementation failed eight of the first nine
cases; the updated implementation passes all twelve. The full portable suite is
217 tests. Tests preserve caller buffers, observe erased owned intermediates,
verify successful encryption round trips and ensure rejected allocation occurs
before any Float32 decode allocation. The normal Signal/TLS/native and integrated
rehearsal workflows remain required on the exact PR head before merge.

AI author review covers success/error ownership, partial outputs, resource checks
before allocation, unchanged cryptographic context and native-key references.
Independent human review is separate final review; this evidence is not a claim
of complete E2EESA conformance, deployment or a finished mobile client.
