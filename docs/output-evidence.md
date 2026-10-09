# Active output and calibrated decision evidence

The portable route lifecycle accepts active-route callbacks from a trusted native adapter. It never reads paired-device names, advertised power or declared output counts as speaker evidence. Route changes and interruptions stop the old playback/evidence path immediately. Android/iOS adapters and actual lock-screen, permission, reconnect and route tests are still required.

`OutputEvidenceEndpoint` challenges one route generation under current consent, then accepts an `output-evidence` control through the existing pinned Ed25519 verifier and an authenticated E2EE payload decoder. The verifier is an explicitly authorized measurement endpoint. It must bind physical output identity, calibration, reference geometry, A weighting, integration window and source attribution. The library validates its decision but does not independently validate its hardware. A captured-origin field is an assertion by that verifier, not independent field evidence.

Unknown fields, raw ambient audio, simulated captures, aggregate fields, headphone routes, stale calibration, cross-route replies, replay, revoked consent and superseded asynchronous replies fail closed or return an unqualified result. Calibration uncertainty is subtracted for the minimum band and added for the safety ceiling. Clock uncertainty trims interval boundaries. Conservative intervals are unioned per physical output; repeating an output through multiple clients cannot multiply its duration.

No point balance, reward policy, audience count or instruction to increase volume is implemented in these neutral modules. Software tests use an explicit payload-decoder adapter and generated keys. Authenticated parent key channels, hardware calibration/attribution, consent UI, rollback-resistant native storage and independent review remain release gates.


A challenge records its start time. The complete uncertain measurement window must follow it, finish before receipt and fit current consent. The stated integration window must equal the capture interval; calibration must cover that complete uncertain window, even if evaluation bounds select a shorter portion. This prevents an uncalibrated or pre-consent average from becoming qualified by trimming its timestamps.

Qualification results are immutable endpoint-local receipts. Coverage rejects copied/forged receipts and mixed session/policy contexts. Serialized copies need authenticated revalidation at the receiving endpoint; a JSON flag is insufficient. Native invalidation state becomes unavailable/interrupted before calling the sink, so a callback exception cannot keep an old route eligible. Native callbacks must stop playback synchronously; actual platform enforcement still needs qualification.
