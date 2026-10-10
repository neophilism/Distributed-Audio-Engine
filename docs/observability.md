# Engine observability contract (DAE-21 reference)

The portable `summarizeEngineSignals` API accepts explicit component observations and returns aggregate, whitelisted operational snapshots suitable for a trusted adapter or an Engine Room feed. The API never queries deployment platforms itself. It does not claim live monitoring, authenticate incoming observations, expose a hosted endpoint, or certify native audio output.

A stale/missing component changes snapshot freshness and health to unknown. Unknown error or session counts remain null, not zero. Currency-specific cost totals require complete fresh measurements; mixed currencies are never added together. Input is bounded, rejects future and duplicate observations, and permits no arbitrary private fields. Components must be supplied by a trusted authenticated provider integration, not browser or sponsor claims.

A production adapter still needs access-controlled ingestion, signatures/source authentication, transport protections, freshness enforcement, legitimate metric definitions, persisted last observations, paging/rate limits and alerting. Do not feed keys, manifests, media, precise physical coordinates, user identity or raw acoustic captures. GitHub PR/CI status comes from Engine Room's existing GitHub sync and should be displayed alongside, not substituted for runtime health. Deployment remains unverified.
