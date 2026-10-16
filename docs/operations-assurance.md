# Operations assurance evidence

DAE-22 accepts evidence for retention policy, deletion drills, restore drills and
source-bound security review/testing. The October 13 owner policy permits AI
review and testing now, with independent human review as follow-up. Absence of
an external audit is not a readiness blocker. Missing tests, unverified evidence
and actual failures are not waived.

`OperationsEvidenceAcceptor` accepts exact-field records only when an application
verifier explicitly returns `true`. Scope, artifact SHA-256, report digest and the
pinned standard commit are bound before use. Future, expired, stale, cross-scope,
cross-artifact and replayed records reject. The verifier must authenticate the
actual report and its test results; a supplied `passed` string is not evidence.

`ai-security-review` means substantive AI-assisted source review, threat analysis,
applicable automated/adversarial/integration tests and remediation. It may be
performed by the implementation author. It never counts as independent review.
`independent-security-review` retains its different-subject/verifier requirement.
Only an actually qualified human report may be provisioned with that kind.

`assessOperationsAssurance(records, binding, nowMs)` defaults to production.
Passing `'staging'` or `'development'` as the fourth argument assesses that exact
environment only. No test-server evidence can satisfy production. The result
reports its environment, `aiReview` and `independentReview` separately. Either
verified passing review path plus all three operational gates permits
`operationsReady`; a current failed review or drill still prevents it. At equal
timestamps failure wins. A newer verified report of the same kind can resolve a
failure. An absent human review remains `pending` without blocking the AI path.

`fieldValidated` and `released` remain false: operations readiness alone does not
prove a physical device, a complete product or certification. This assessment
neither deploys a service nor runs a drill itself. Adapters retain authenticated
reports and provide only bounded identifiers/digests here; private reports, keys,
credentials and backup contents must never enter operational records or logs.

The existing E2EESA implementation pin is unchanged. Updating that pin requires
reviewing applicable changes, not waiting for human certification. Deployed drills
must exercise actual retention/deletion, backup integrity and an isolated restore.
