# Complete-product purchases

`CheckoutEngine` creates immutable, revision-bound complete-product quotes. Every included asset must have sale and download permission for the buyer's territory. Exact decimal minor-unit strings and explicit currency/exponent avoid floating-point accounting. Purchase and merchant roles come from the trusted identity adapter.

Reservation precedes provider I/O. Retries use the same provider idempotency key; failures remain retryable reservations. A provider must implement its real idempotency behavior. Reusing an intent/payment ID for another order, changing the buyer/product/price, or changing a replayed event is rejected. Provider-signed settlement is verified on the original raw webhook by an injected adapter before state changes; TLS or a client success screen is insufficient. Settlement time must lie within the original quote. An unchanged retry returns the original quote after a catalog revision.

The merchant and payment provider are intentionally authorized recipients of opaque order, scoped buyer, amount, currency and settlement facts required to process the purchase. Applications must provision appropriately scoped buyer references and explicitly authorize these recipients. Product titles, media, manifests and keys never enter payment requests or commerce persistence. Catalog/rights inputs stay at authorized endpoints; confidential transport to an authorized merchant uses the selected authenticated application channel. This module does not implement that channel.

`CommerceStore` requires synchronous atomic transactions with rollback. The memory implementation is a bounded reference; persistent adapters must provide process-safe durability. A settled order records a financial fact, not media recipient enrollment or an entitlement/key grant. Download fulfillment requires separate fresh rights, buyer/device authority and E2EE recipient checks. Provider refund/reconciliation and entitlement integration are subsequent modules. No real payment provider is configured or contacted by these tests.

## Splits, refunds and transfer reconciliation

`ReconciliationEngine` consumes actual provider-confirmed fee/refund/transfer facts through a raw-webhook verifier and checks the persisted settled checkout. Authorized agreements are immutable by ID/revision and require an authorization evidence digest. Agreements must explicitly cover fee and refund liability allocation; a recorded digest is not a finding about their legal validity.

Exact largest-remainder allocation uses deterministic opaque payee-ID ties. Refunds recompute obligations from cumulative totals, so dividing a refund into many events cannot accumulate rounding windfalls. A full customer refund with a retained provider fee produces negative liabilities; prior successful payouts produce recovery balances. Those amounts remain visible and are never silently clamped to zero.

Transfer reservations commit before external dispatch and reduce available balances. A timeout remains pending because a provider might have executed the transfer. Only authenticated final provider success/failure resolves it. Confirmed failures remain in reports; retries require a new explicitly reserved transfer ID after balance review. The dispatch adapter must honor each reservation's provider idempotency key. This implementation produces commands and reconciles facts; it does not dispatch real transfers/refunds or configure a provider.

Checkout and accounting stores are separate atomic domains. Capturing a settled checkout is repeatable after a crash; accounting events commit in their own idempotent transaction. Production adapters must enforce access, retention, process-safe durability and recovery for the intentionally disclosed business facts. Tests exercise generated local facts, not a payment-provider sandbox.

## Durable Node adapters

The Node export supplies `SqliteCommerceStore` and `SqliteAccountingStore`. They use real SQLite `BEGIN IMMEDIATE` transactions, WAL, FULL synchronization, bounded strict JSON snapshots and complete business-field whitelists. Reopen and separate-process settlement tests exercise the actual database. Returned values are detached; throwing callbacks, async callbacks and uncloneable results roll back. Unknown private fields cannot enter these snapshots.

These databases belong to authorized business endpoints. They contain intentionally processed opaque purchase/accounting metadata in plaintext at that recipient; they are not ciphertext-only relay stores. File-backed adapters require an owner-private POSIX directory, reject a final-path symlink and enforce file mode 0600. Platform/disk encryption, backups, deletion/retention, tamper/rollback resistance and actual payment-provider recovery qualification remain deployment work. Snapshots are limited to 1 MiB per scope/domain; exceeding that fails rather than truncating financial records.
