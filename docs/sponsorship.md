# Sponsor delivery accounting (DAE-19, portable reference)

SponsorAccounting tracks scoped, preapproved campaigns and generic creative delivery events. It reports **delivery event count**, **qualified output event count**, and an explicitly unknown/null people count. It does not claim unique listeners, impressions, acoustic proof, campaign invoice accuracy or revenue; none of those can be inferred from this module.

A trusted SponsorEventVerifier must authenticate the original source event. Before it returns a qualified-output fact, the integrating endpoint must independently verify opt-in calibration, active speaker/output route, source attribution, challenge binding and authorized measurement evidence. A hash-looking outputEvidenceRef is an auditable reference, **not proof** by itself. The reference implementation does not implement those integrations. It rejects unbound qualifications, repeated qualification of a single delivery, event substitution, unapproved creatives, inactive campaigns and quota overflow.

MemorySponsorStore demonstrates synchronous atomic rollback, cloned responses and scoped event state. Production must supply a durable transactional adapter, independent authenticators, a verified evidence pipeline, retention/consent policies, and actual sponsor/business settlement integration. The portable reference does not send advertisements, process payments, count people, connect to a sponsor service or deploy itself.

No private media, decrypted manifests, keys or raw ambient audio belong in a sponsor event. This module deliberately contains no radio cadence, audience targeting or artist reward economics; those belong in consumer repositories.
