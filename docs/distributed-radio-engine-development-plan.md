# Distributed-Radio-Engine: development plan

Requested order: Distributed-Audio-Engine → SceneSignal → Distributed-Radio-Engine → TrackZero.

## DRE-01 — Repository and reusable radio contracts

Dependencies: DAE-23. Origin: added.

Establish neutral radio engine, generic creators/publishers, media items and show contracts. No TrackZero branding, venue or location policy.

Acceptance: A music and a documentary consumer compile against the same public contracts.

Gate: Software.

## DRE-02 — Creator and publisher identity adapters

Dependencies: DRE-01. Origin: added.

Artist, organization, station ownership and collaborator roles with tenant/application isolation and endpoint device authority.

Acceptance: External account login alone cannot enroll a decrypting recipient.

Gate: Software.

## DRE-03 — Station editorial authority

Dependencies: DRE-02. Origin: added.

Artist/organization-controlled programming, collaborator scopes and signed revision approvals.

Acceptance: Unauthorized sequencing or sponsor insertion fails; approvals bind exact program digest.

Gate: Software.

## DRE-04 — General radio content catalog

Dependencies: DRE-02. Origin: added.

Music, news, documentaries, talk shows, episodes and creator attribution; assets consume core encrypted packaging.

Acceptance: Music and spoken-work fixtures use the same pipeline without song-specific assumptions.

Gate: Software.

## DRE-05 — Rights and publishing checks

Dependencies: DRE-03, DRE-04. Origin: added.

Required composition/recording or spoken-work permissions, territory, release window and cache/reward grants.

Acceptance: Missing uses prevent publishing; revocation does not invent recall of already delivered files.

Gate: Software.

## DRE-06 — Program compiler and completion boundaries

Dependencies: DRE-05. Origin: added.

Compile content, opening identification, closing identification and before-next-intro reward markers into the common timeline.

Acceptance: Points closure always follows the full matching outro; opportunities occur before the next intro.

Gate: Software.

## DRE-07 — Scheduling, loops and versioned rotations

Dependencies: DRE-06. Origin: added.

Scheduled shows, recurring blocks, fallback sets and future-effective revisions owned by the broadcaster.

Acceptance: Continuous station survives publisher disconnection; no user-selectable on-demand track playback.

Gate: Software.

## DRE-08 — Interstitial and identification adapters

Dependencies: DRE-06. Origin: added.

Uploaded/recorded station IDs and deterministic per-content identification metadata, including That was SONG by ARTIST on STATION radio.

Acceptance: Silent placeholders never count as completed required identification; artist controls actual audio.

Gate: Software.

## DRE-09 — Sponsor placement and common-program accounting

Dependencies: DRE-07, DRE-08. Origin: added.

Broadcaster-approved ads, campaigns and split accounting on one authoritative station sequence.

Acceptance: No individualized audio ad insertion changes playback timeline; ads do not earn song points.

Gate: Software.

## DRE-10 — Always-on encrypted station operations

Dependencies: DRE-07, DRE-09. Origin: added.

Endpoint prepublication of encrypted audio/programs, autonomous ciphertext scheduler, recovery and fixed approved versions.

Acceptance: Station keeps broadcasting without artist phone; relay/storage never receives media decryption keys.

Gate: Software.

## DRE-11 — Radio join and playback SDK facade

Dependencies: DRE-10. Origin: added.

Guest live radio, current timeline join, native/web wrappers and backpressure/recovery.

Acceptance: Tuning in joins current program; supported client types expose honest route/evidence states.

Gate: Software.

## DRE-12 — Contribution point policy and units

Dependencies: DRE-05, DRE-11. Origin: added.

One creator-specific metric: conservative measured acoustic-energy equivalents integrated over qualifying time. Threshold, reference level, safety ceiling and versioned unit fixed in policies.

Acceptance: No headphone, software-slider or subthreshold credit. Accounted quantity is points, not summed physical decibels.

Gate: Software.

## DRE-13 — Independent multi-speaker evidence

Dependencies: DRE-12. Origin: added.

Deduplicate physical output identities and calibrated source evidence; sum distinct verified output contributions, never a combined field plus its component speakers.

Acceptance: One output fanned out through multiple clients counts once; unverified 1000-speaker declarations earn nothing.

Gate: Software.

## DRE-14 — Realtime provisional point progress

Dependencies: DRE-12, DRE-13. Origin: added.

Preview per-content points while playback is active; do not create spendable balance yet.

Acceptance: Preview and settled balances remain distinct; failed evidence windows earn zero.

Gate: Software.

## DRE-15 — Outro-complete point vesting

Dependencies: DRE-06, DRE-08, DRE-14. Origin: added.

Award once per completed broadcast occurrence only after full content and its closing identification; stop, pause, seek, mute or route interruption forfeits provisional cycle. Late join starts eligibility at next full cycle.

Acceptance: Race/replay and cross-station duplicate-cycle tests vest once; stopping during outro vests zero.

Gate: Software.

## DRE-16 — Creator-specific transactional point wallets

Dependencies: DRE-15. Origin: added.

Append-only earn/spend ledger, fixed-point units, idempotency, persistence, concurrency and creator isolation.

Acceptance: No transferable universal wallet; spending one artist balance cannot consume another.

Gate: Software.

## DRE-17 — Default exponential reward price ladder

Dependencies: DRE-16. Origin: added.

Slow initial increases that transition into unbounded exponential growth with arbitrary precision, creator overrides and immutable offer-price snapshots.

Acceptance: High tiers exceed feasible 1000-speaker all-day examples; no floating-point balance overflow or retroactive repricing.

Gate: Software.

## DRE-18 — Points reward catalog and atomic redemption

Dependencies: DRE-05, DRE-16, DRE-17. Origin: added.

Creator-defined points offers, coupons, recordings and other lawful fan rewards; cost/budget/stock and atomic entitlement issuance.

Acceptance: Concurrent redemption cannot overspend; failed grant restores balance; no paid-single disguise.

Gate: Software.

## DRE-19 — Separate Unlocked Groove catalog

Dependencies: DRE-05. Origin: added.

App-exclusive bonus recordings separated from point offers and paid catalog. Distinct alternate takes have distinct recording IDs.

Acceptance: The same recording cannot be silently offered in both reward channels; prior entitlements survive edits.

Gate: Software.

## DRE-20 — Shared transition opportunity scheduler

Dependencies: DRE-06, DRE-19. Origin: added.

Broadcaster-defined every x-to-y completed content cadence, one shared timeline opportunity after outro and before next intro.

Acceptance: One opportunity ID/time reaches all connected clients; joining/reconnecting cannot reroll it.

Gate: Software.

## DRE-21 — Exponential rarity and fair eligibility

Dependencies: DRE-20. Origin: added.

Configurable exponentially decreasing rarity weights, listener lifetime completion gates and seeded auditable server/issuer draws with positive-tail probabilities.

Acceptance: Superlisteners retain access to rare tiers; rarity does not decrease to zero merely because they listen longer.

Gate: Software.

## DRE-22 — Listener completion progress including headphones

Dependencies: DRE-11, DRE-15, DRE-21. Origin: added.

Recoverable per-creator completed-listen history; headphones are eligible for Grooves and never speaker points.

Acceptance: Changing output route does not reroll opportunities; muted/background-halted playback is not completion.

Gate: Software.

## DRE-23 — Groove grant ledger and secure delivery

Dependencies: DRE-19, DRE-20, DRE-21, DRE-22. Origin: added.

Idempotent grants, bounded budgets/stock, duplicate protection and endpoint-only content access; program continues while UI reveals reward.

Acceptance: Replay/reconnect grants once; personalized reward never replaces radio audio or desynchronizes listeners.

Gate: Software.

## DRE-24 — Commerce and complete-work products

Dependencies: DRE-04, DRE-18, DRE-23. Origin: added.

Whole albums for music and complete show/documentary works for nonmusic; optional tips/gifts, splits and provider adapters.

Acceptance: Paid standalone music singles remain unsupported; purchases never require speaker participation.

Gate: Software.

## DRE-25 — Creator and sponsor reporting

Dependencies: DRE-09, DRE-16, DRE-23, DRE-24. Origin: added.

Output contribution, lifetime/balance points, grants and transactions reported independently from audience estimates.

Acceptance: Out-loud output does not assert a particular number of people heard it; no exact location requirement.

Gate: Software.

## DRE-26 — E2EESA security, privacy and recovery

Dependencies: DRE-10, DRE-13, DRE-16, DRE-23. Origin: added.

Client-origin encrypted radio/rewards, endpoint-authorized keys, metadata minimization, recovery and dependency/secret gates.

Acceptance: No private content, raw ambient audio or secret key in infrastructure/logs; declared operational metadata inventoried.

Gate: Software.

## DRE-27 — Mixed-content and radio integration pilot

Dependencies: DRE-18, DRE-23, DRE-24, DRE-25, DRE-26. Origin: added.

End-to-end music and news/documentary consumer fixtures, encrypted playback, vesting/spend and timed Grooves.

Acceptance: Actual supported-output evidence distinct from simulations; all semantic paths tested.

Gate: Software.

## DRE-28 — Stable reusable radio release

Dependencies: DRE-27. Origin: added.

Native consumer contracts, developer kit, support matrix, independent security review and release evidence.

Acceptance: No TrackZero dependency or branding in engine; unresolved assurance gates block production claim.

Gate: Software.

