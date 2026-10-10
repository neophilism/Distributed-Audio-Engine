# Operations assurance evidence

DAE-22 adds a portable, fail-closed contract for retention policy, deletion drill, restore drill and independent security review evidence. It does not perform a deployment, delete hosted data, restore a backup, appoint an independent reviewer or authorize a release.

`OperationsEvidenceAcceptor` accepts exact-field records only through an application-supplied verifier. Every record is bound to the tenant, Distributed Audio Engine component, exact subject artifact SHA-256, production environment and the pinned 40-character E2EESA commit. Evidence IDs and report digests cannot be replayed within an acceptor. Future, expired, stale, cross-scope, cross-artifact and cross-standard records reject. A security review whose verifier is its subject is not independent.

`assessOperationsAssurance` reports satisfied, failed and missing gates separately. Development and staging evidence never satisfies a deployed gate. Only current verified production evidence for all four kinds makes `operationsReady` true, and even then the result fixes `fieldValidated` and `released` to false. Other roadmap, native-device, product-integration and release gates remain independent.

The implementation remains pinned to E2EESA `0.9.0-rc.1` commit `dea8f54cab9130da86a71f36de553766a978daf2`. Upstream Audit v2 remediation and an eventual corrected candidate must be reviewed before changing profiles or making a conformance claim. This package does not reinterpret the changing upstream draft.

Adapters must authenticate evidence outside this library, retain the signed report in an authorized evidence system, supply only its digest and bounded identifiers here, and keep private reports, credentials, media keys and backup contents out of records and logs. Deployed drills must verify actual retention/deletion propagation, backup integrity and restoration into an isolated authorized environment.
