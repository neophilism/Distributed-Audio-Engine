# Ciphertext relay test deployment on Render

This deploys the actual bounded ciphertext relay, not a status-only mock. It
stores public prekeys, encrypted signed controls, opaque message packets and
endpoint-encrypted audio chunks. Media keys, private manifests, ratchet state and
decoded audio remain at separately authorized endpoints. Routing access is never
an endpoint membership or media authorization grant.

The exact data-flow inventory is [render-relay-flow.json](render-relay-flow.json).

## Explicit transport boundary

The standalone `createCiphertextRelay` entry point remains TLS-only, requiring
its own certificate/key and TLS 1.3. It does not accept forwarded-header trust or
an HTTP fallback. Endpoint `CiphertextRelayClient` still requires verified HTTPS,
rejects redirects and has no insecure-certificate option.

Render's documented edge terminates public HTTPS and forwards HTTP to the
service's non-public port. The separate `createRenderEdgeCiphertextRelay` entry
point explicitly supports that managed boundary for staging only. Authenticated
routes require the exact configured onrender.com host and one `X-Forwarded-Proto:
https` header; all existing authentication, content, quota, expiry, duplicate,
revocation and request-limit checks still run. Those headers are not proof of TLS
on an arbitrary public HTTP server. Do not use this entry point outside Render's
protected ingress. Proxy operators can observe bearer routing credentials and
routing metadata, but cannot decrypt protected endpoint content.

`GET /healthz` permits Render's internal probe without a forwarded scheme or
credential. It probes the real SQLite store and returns the exact deployed source
commit, transport and storage profile. `routingConfigured` distinguishes a running
empty relay from one with currently unexpired routing grants. It never reports
`productionReady: true`, physical output, or completed product readiness.

## Deploy and configure

The root `render.yaml` selects a **free**, manual-deploy Node 24.19.0 test service.
It runs the actual relay test suite before startup. The launcher refuses an
implicit production mode, another repository, a malformed origin/commit, a
reserved port or secret-bearing grant fields. It reads documented Render
variables, binds `0.0.0.0:$PORT`, creates an owner-private ephemeral SQLite directory
and closes connections and storage on shutdown. It never logs configuration,
bearer tokens, private payloads or database errors.

Set `DAE_RELAY_MODE=render-staging` and `DAE_RELAY_GRANTS_JSON` to a JSON array of:

```json
{
  "tokenSha256": "SHA256_OF_INDEPENDENT_ROUTING_TOKEN_TEXT",
  "address": "ROOT_VERIFIED_ENDPOINT_ADDRESS",
  "expiresAtMs": 0,
  "allowedRecipients": ["AUTHORIZED_PEER_ADDRESS"]
}
```

The uppercase strings and zero expiry above are documentation placeholders and
are intentionally not valid production credentials. The default empty array
provides no client access. Generate independent 32-byte random base64url tokens
at the corresponding test endpoints, hash the token **text** with SHA-256, and
send only these hashes/public addresses to the operator configuration. Supply a
real future expiry, not the documentation zero. Configure each intended recipient
with its own active grant. Never copy endpoint vault keys into these settings.
No paid API or third-party account credential is needed to run the relay itself.

## Temporary storage is explicit

Render free web services have an ephemeral filesystem and can sleep or restart.
This launcher intentionally creates a new bounded test store on each start:
128 packet/tombstone records, 64 per mailbox, 2 MiB packet data, 64 encrypted chunks
and 8 MiB chunk data. All content is disposable test material. It is **not** a
durable mailbox or an always-on production station. Restart may lose public
prekeys, ciphertext and relay acknowledgment tombstones. Endpoints retain their
own atomic journals and receiver replay checkpoints; recovery must use explicit
republishing/retries and fresh authority where needed. Never infer exactly-once
execution from an ephemeral relay receipt. For durable service, use the standalone
TLS launcher with separately authorized persistent storage, or an independently
tested persistent datastore adapter. No paid storage is provisioned here.

Free service runtime shares the workspace allowance; builds and outbound traffic
also count against platform limits. Keep rehearsals small and bounded. This
configuration adds no paid plan, disk, background worker, cron job or keepalive
loop; it does not guarantee platform usage remains below every account quota.

## Verification

Eleven new local managed-edge/configuration tests cover exact host/scheme admission,
endpoint isolation, real TLS proxy interoperability, token configuration,
expiry, clock rollback, launcher startup/cleanup and redacted failure output.
The existing 24 standalone TLS/storage tests remain active. Two extra actual
Signal-to-TLS-to-production-C tests exercise this managed-edge path for both mobile
sink contracts; these still use synthetic routes/clocks, not physical phones.
Hosted CI must pass before merge. A separate live-cloud rehearsal is required to
claim actual deployed public-network end-to-end delivery; localhost proxies alone
are not that evidence. AI source review is separate from later human review.

Official platform references (checked October 16, 2026):
- https://render.com/docs/web-services (HTTPS edge and non-public service port)
- https://render.com/docs/environment-variables (documented runtime variables)
- https://render.com/docs/free (sleep, ephemeral storage and usage allowances)
