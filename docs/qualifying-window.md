# Current route and qualifying-window evaluator (DAE-14)

`evaluateCurrentWindow` adds a live native-route and current-consent check to the authenticated acoustic evidence evaluator. A captured measurement may only qualify when the route is currently active and playback-supported; its exact endpoint, physical output, route ID and generation must match, consent has not expired, and the requested time window is not in the future.

It delegates calibrated A-weighted bounds, uncertainty trimming, attribution and sound-level policy to `evaluateContribution`; a fabricated JavaScript object is not a substitute for its authenticated evidence brand. Route changes, interruptions, unsupported output, expired consent and future windows return unqualified results.

Passing software tests or a route profile are not physical speaker-emission proof. The result retains `fieldValidated: false`, and a separate real-device qualification program is necessary before field claims.
