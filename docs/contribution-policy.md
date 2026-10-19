# Neutral contribution-policy primitives (DAE-15)

`PinnedContributionPolicy` validates a bounded A-weighted contribution band once and retains an immutable snapshot. Invalid levels, reversed safety ceilings, excessive uncertainty, unsupported output kinds, duplicate output kinds and malformed geometry are rejected at construction. Subsequent caller mutation cannot broaden allowed physical-output classes or alter level limits.

The `evaluate` method delegates to the authenticated `evaluateContribution` decision gate. Simulated, aggregate, uncalibrated, inconclusive, unsupported, over-limit, stale and fabricated evidence cannot qualify; the independent current-route/consent and native output checks are handled by the DAE-14 window evaluator.

This neutral primitive cannot instruct a client to raise volume and does not include points, reward economics, song or radio business policies. Software qualification is not physical field validation.
