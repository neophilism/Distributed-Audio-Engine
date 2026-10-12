# TLS ciphertext relay and endpoint transport

A runnable Node 24 service for **public prekey bundles, encrypted parent messages,
signed encrypted controls and ciphertext audio chunks**. It is separate from the
creator/listener endpoint: it does not load libsignal, possess endpoint vault
keys, transcode media, receive private manifests, or decode PCM. The operator's
TLS certificate key is a transport key, not a content-decryption key.

This implementation closes the local-network transport gap for the Node endpoint
integration. It is not a cloud deployment, mobile application, production release
or device/acoustic qualification. Endpoint onboarding still requires genuine
account-root verification and explicit trusted peer permissions.

## Start a configured service

Build the portable modules first with the repository's pinned dependencies:

```sh
npm ci --ignore-scripts
npm run build
node services/ciphertext-relay/src/main.mjs /absolute/private/relay.json
```

The configuration file has exactly these fields:

```json
{
  "host": "127.0.0.1",
  "port": 8443,
  "databasePath": "/absolute/private/relay.sqlite",
  "tlsKeyFile": "/absolute/private/tls-key.pem",
  "tlsCertificateFile": "/absolute/private/tls-certificate.pem",
  "grants": []
}
```

Paths are operator inputs, not supplied credentials or existing infrastructure.
The configuration and TLS files must be owner-private regular files (0600), in
real owner-private directories (0700), with no symbolic/hard links. Obtain a
certificate valid for the actual hostname/IP from the approved infrastructure;
there is no auto-generated production certificate or disabled-verification mode.
An empty grant array starts health checks only and permits no message access.
Bind externally only as a deliberate operator configuration, behind appropriate
network access controls. SIGINT/SIGTERM drain requests and close the SQLite store.

Each routing grant is `{tokenSha256,address,expiresAtMs,allowedRecipients}`.
Generate an independent random 32-byte token, encode it as canonical base64url,
and place only SHA-256 of that token string in the relay configuration. Give the
original token only to its authorized endpoint over approved onboarding. Address
values are the deterministic 64-hex peer addresses returned by the Signal
integration. Grants are explicit, expiring and bounded to 64 credentials with at
most 32 allowed recipients each. The in-process operator policy supports grant
replacement/revocation; there is no public administration endpoint. Never reuse
an account root, device key, media key or vault key as a routing token.

**Routing access does not grant E2EE membership.** A valid bearer credential can
route opaque records, but cannot replace enrolled identity keys or authorize
playback. The recipient verifies the signed public bundle, ratchet message,
current device membership, private control header, replay sequence and rights.
The relay checks record shapes and route bindings; it cannot prove that arbitrary
caller-supplied bytes are encrypted. Only the approved endpoint encoder may be
used to produce protected content.

## Endpoint API

`CiphertextRelayClient({origin,token,ca?,timeoutMs?})` requires an HTTPS origin,
verified certificates/hostnames and TLS 1.3. A private test/enterprise CA may be
provided explicitly; there is no insecure agent or verification-disable option.
It rejects redirects, compressed/unbounded/malformed responses and query tokens.
Its whole-operation timeout covers connection establishment and response body,
not only socket inactivity. Cancellation/close destroys outstanding requests;
at most eight may be outstanding. It performs no automatic retry or background
polling.

The client supports `publishBundle`, `takeBundle`, `send`, `poll`, `acknowledge`,
`uploadChunk`, and `chunksFrom`. The latter implements the portable
`CiphertextChunkTransport`, bound to a specified sender and tenant/application.
Feed it to `SignalPlaybackInbox.sessionOptions` for actual network playback.

A send packet is `{deliveryId,recordType,record,expiresAtMs}`. `recordType` is
`signal` (the opaque ratchet record) or `control` (the existing DAE signature and
its Signal-encrypted payload). Re-send the **identical saved packet** after an
uncertain response. A changed packet with the same ID fails; an acknowledged
packet keeps a digest tombstone until expiry and cannot be reinserted. Polling
returns at most eight messages in persistent insertion order. Acknowledgments
are scoped to the caller's mailbox, and do not assert that a person heard sound.

`uploadChunk` accepts only `{application,tenantId,storageObjectId,chunkIndex,
ciphertextBase64,readers,expiresAtMs}`. The reader list is explicit routing metadata;
every reader must be permitted by the sender's current grant. Stored chunks are
immutable through their expiry. Uploading different bytes, extending expiry or
changing readers under the same object/index is rejected. New permissions require
new endpoint packaging/identifiers. Private filenames, media keys, private hashes
and full manifests are not accepted by this API. Audio chunks are limited to
256 KiB + 16 authentication bytes; the core's default 64 KiB chunks fit. Larger
core codec configurations are explicitly unsupported by this adapter.

## Persistence, limits and failure behavior

SQLite uses a private database, full synchronous commits, atomic transactions,
application/schema identification, link checks and a persisted time watermark.
It stores ciphertext/public metadata only. Mailbox acknowledgment clears the
ciphertext body but retains a bounded duplicate tombstone. Public prekey bundles
are removed atomically on take, and a consumed bundle cannot be republished as
fresh while its tombstone is retained. Losing a take response may waste a prekey;
the recipient must replenish it, never reuse an already-consumed one.

Messages, keys and audio expire within five minutes. A running retention timer
purges expired records even when no recipient polls. Clock rollback latches the
service unhealthy rather than extending old permissions. Default capacities are
1,024 message/tombstone records, 64 pending per mailbox, 8 MiB message bodies,
256 public bundles (64 available per owner), and 1,024 audio chunks / 64 MiB total.
Quotas reject new work without silently evicting unacknowledged messages. Limits
are also enforced on connections, headers, request deadlines, body sizes and
response lengths. Each configured credential has a 256-request/10-second budget.

A relay acknowledgment means its SQLite transaction committed, not that an
endpoint application processed the message exactly once. Endpoint ratchet state
is independently transactional, but an application crash between decrypting a
message and saving its result still needs a durable endpoint inbox/outbox or a
fresh authenticated rejoin. Do not infer automatic playback resume from relay
persistence. Deployed backup/restore, rollback resistance and cross-process crash
injection remain acceptance work. Database deletion is not proof that all old
filesystem snapshots/backups were erased. No production retention certification
is asserted.

## Tests

```sh
npm run typecheck --prefix services/ciphertext-relay
npm test --prefix services/ciphertext-relay
npm ci --ignore-scripts --prefix integrations/signal-parent
sh services/ciphertext-relay/test-network.sh
```

The 24 transport/storage/launcher cases use real SQLite and TLS, including private
configuration startup/reopen, isolation, duplicate suppression, one-time bundles,
expiry, quotas, certificate validation, request/response limits and cancellation.
Eight additional cases exchange real Signal keys, private manifests, signed
controls and multi-chunk encrypted audio over actual TLS sockets and render the
result through the production C kernel. The native output route/clock and content
are synthetic; these tests are not a physical mobile/speaker trial. Test TLS keys
are generated only in temporary directories, never committed or used as a service
credential. CI runs these checks against the exact source before merge.
