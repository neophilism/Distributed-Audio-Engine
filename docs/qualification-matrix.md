# DAE-31 scale, resilience and contract qualification

The deterministic contract tests in `tests/scale-resilience.test.ts` simulate 1,000 successive active-output revisions and 1,000 independently tracked physical objects. They assert replay rejection, immediate route invalidation, object/tracker isolation, staleness enforcement and the separation of fixed speaker placement from moving tracker observations.

These are in-process software test fixtures. They are not throughput benchmarks, six-hour hardware soaks, radio synchronization trials, supported-device compatibility evidence or acoustic emission measurements. The final qualification matrix must distinguish simulated contract testing from hardware/production observations and retain exact-head CI evidence before asserting acceptance.
