# Leased local ciphertext routing

A local coordinator serves opaque encrypted chunks on a pre-registered transport. It does not receive media keys, private asset descriptors, output gain control or recipient authority. An authorized primary endpoint grants a scoped, program-bound `coordinator-lease` through signed controls and the separate authenticated E2EE payload decoder. The lease lasts at most 30 seconds, with its term bound to the signed control epoch and replay persistence handled by the verifier's checkpoint adapter.

`CoordinatorMonitor` validates the scope/program/term/expiry and protects asynchronous verification/decryption against disconnect or supersession. `CoordinatorChunkTransport` maps the signed opaque coordinator ID only to configured transports; a command cannot inject a host, URL or network address. Network discovery and authenticated transport provisioning remain platform integration tasks.

An absent/unregistered/expired local host, missing chunk, wrong length, timeout or lease change uses the configured ciphertext fallback. Local and fallback attempts have separate bounded deadlines. Cancellation and closure stop the current request rather than initiate a new fallback. The endpoint reader still authenticates every chunk before media reaches a decoder. Either delivery path feeds the same program timeline; host failover never changes track order or creates personalized content.

These are per-endpoint routing leases and bounded availability fallbacks, not a distributed consensus or automatic leader-election protocol. A primary endpoint must authorize replacements; clients do not self-elect new key recipients or bypass a control gap. Playback authority remains a separate expiring signed lease, so cached data or a local host cannot sustain output after that authority ends.

Portable tests exercise primary authorization, missing/unknown/timed-out hosts, lease expiry during transfer, cancellation, close, forged/replayed/cross-scope controls and disconnect races. Actual LAN discovery, authenticated private-network deployment and hardware joins remain pending evidence.
