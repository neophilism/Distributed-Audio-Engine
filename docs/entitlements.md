# Generic entitlement ledger

`EntitlementLedger` records issuer-authorized resource/use grants for a scoped subject. The trusted identity adapter supplies the issuer's `entitlements:manage` role and the subject's current `assets:read` authority. The ledger does not calculate contribution, balances, consumer reward costs or station completion rules.

Resources and their permitted-use lists are explicitly set-valued and normalized before binding. Source kind/record ID has one grant owner within the issuer scope. Competing grant IDs for the same unchanged source return the original grant; changed subjects, resources, expiry or authorization evidence reject. Replaying a revoked grant preserves terminal revocation. Expired or revoked grants deny access. Nullable expiry means permanent bookkeeping access, while every delivery still needs fresh bounded recipient authority and rights checks.

Authorization evidence references identify the issuer's policy record; this primitive does not independently attest a contribution or settle a purchase. Integration must verify those source records before using the issuer role. Successful access evaluation never enrolls devices, conveys a manifest/key or implements the authenticated parent channel. Refund-triggered revocation and complete-product fulfillment remain application/integration work.

Memory and Node SQLite stores implement atomic transactions, source deduplication, rollback, detached results and disclosure whitelists. The SQLite adapter uses the same private-directory, file-mode, bounded-snapshot and process-safe transaction rules as the commerce adapters. Stored opaque grant/access facts are intentionally processed by the authorized issuer endpoint; media, manifests and keys are excluded. Encrypted transport, deployed disk/backup protection, retention, rollback resistance and real recipient integration remain qualification work.

This is a partial portable DAE-16 implementation while native contribution and key-channel dependencies remain open. Tests cover competing IDs, identity isolation, expiry, terminal revocation, private-field rejection and actual database reopen.
