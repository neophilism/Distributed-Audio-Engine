# SceneSignal: development plan

Requested order: Distributed-Audio-Engine → SceneSignal → Distributed-Radio-Engine → TrackZero.

## SS-01 — Repository and application shell

Dependencies: DAE-01. Origin: original (EP-01).

Separate SceneSignal product shell and E2EE client; consumes the core without radio-engine or TrackZero imports. Use user-centered community and spatial music language.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-02 — Organizer and collaborator roles

Dependencies: SS-01. Origin: original (EP-02).

Enforce organizer, performer, operator and steward permissions.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-03 — Site and session planning

Dependencies: SS-02. Origin: original (EP-03).

Record operating site, time, boundaries and session conditions.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-04 — Permit evidence upload

Dependencies: SS-03. Origin: original (EP-04).

Endpoint-encrypt permits and private organizer data. Retain conditions and explicit authorizer decisions without exposing full documents to storage/admins; redacted public summaries are intentional disclosures.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-05 — No-permit-required attestation

Dependencies: SS-04. Origin: original (EP-05).

Capture the location-specific basis and conditions of the organizer assertion.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-06 — Authorization lifecycle and enforcement

Dependencies: SS-05. Origin: original (EP-06).

Prevent activation without current permitted authority and invalidate changed site conditions.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-07 — Artist calls and lineup agreements

Dependencies: SS-06. Origin: original (EP-07).

Recruit performers and record lineup, duration, rights and financial terms.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-08 — Free event discovery and visitor pages

Dependencies: SS-07. Origin: original (EP-08).

Offer accessible public event information without a ticket or audience account.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-09 — Session sponsorship

Dependencies: SS-08. Origin: original (EP-09).

Manage transparent sponsor commitments, placements and costs.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-10 — Artist album sales and optional support

Dependencies: SS-09. Origin: original (EP-10).

Offer complete albums, voluntary support and agreed artist shares.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-11 — Speaker-contributor onboarding

Dependencies: SS-06, DAE-12. Origin: original (EP-11).

Join speakers voluntarily with explicit permissions and supported-device status.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-12 — Local coordinator and site setup

Dependencies: SS-11. Origin: original (EP-12).

Prepare local playback, caches and operator diagnostics.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-13 — Fixed-speaker placement map

Dependencies: SS-12. Origin: original (EP-13).

Place speakers independently of the owner phone, including fixed-on-blanket mode.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-14 — Speaker roles and calibration

Dependencies: SS-13. Origin: original (EP-14).

Assign useful coverage and frequency roles using measured capabilities.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-15 — Stem and composition ingestion

Dependencies: SS-07, DAE-06, DAE-24. Origin: original (EP-15).

Import authorized aligned stems and complete fallback mixes.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-16 — Spatial scene composer

Dependencies: SS-15. Origin: original (EP-16).

Place instruments and define spread with a visual scene interface.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-17 — Scene audition and simulation

Dependencies: SS-16. Origin: original (EP-17).

Preview mixes and missing-contributor situations using labeled simulations.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-18 — Static spatial field playback

Dependencies: SS-14, SS-16, SS-17, DAE-25. Origin: original (EP-18).

Drive calibrated fixed speakers with position-dependent instrument mixtures.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-19 — Dynamic density and contributor changes

Dependencies: SS-18. Origin: original (EP-19).

Smoothly adapt musical weights when contributors arrive or leave.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-20 — Moving-speaker position tracking

Dependencies: SS-19. Origin: original (EP-20).

Update only actual speaker positions using confidence-bounded tracking.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-21 — Spimes: movable physical instrument anchors

Dependencies: SS-16, SS-20, DAE-28. Origin: original (EP-21).

A Spime is a Bluetooth-enabled statue, giant chess piece, violin or other physical object whose validated location controls a virtual instrument/stem position. Bind object ID, tracking method, calibration, confidence, owner and scene; consented encrypted telemetry. Presence or RSSI alone is not precise location.

Acceptance: Moving a validated Spime moves its assigned virtual source; stale, low-confidence and disconnected tracking freezes/fades safely. The speaker/phone/object locations remain separate; manually placed fallback works.

Gate: Actual field evidence for hardware/production claims.

## SS-22 — Preprogrammed spatial automation

Dependencies: SS-21. Origin: original (EP-22).

Schedule instrument movement and scene transitions on the common clock.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-23 — Live scene control and operator handoff

Dependencies: SS-22. Origin: original (EP-23).

Apply authorized edits with undo and safe operator transfer.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-24 — Session contribution rewards

Dependencies: SS-14, DAE-14, DAE-16. Origin: original (EP-24).

Session-specific validated contribution rewards and useful-role credits using neutral core primitives. Does not import TrackZero point vesting or Unlocked Groove rules; authorizer and safe limits bound contribution.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-25 — Accessibility and equitable participation

Dependencies: SS-24. Origin: original (EP-25).

Support non-device visitors, quiet routes, readable controls and alternate formats.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-26 — Acoustic monitoring and emergency controls

Dependencies: SS-25. Origin: original (EP-26).

Monitor permitted output and execute authenticated fade/stop controls.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-27 — Weather, access and site operations

Dependencies: SS-26. Origin: original (EP-27).

Coordinate cancellation, access, contacts and incident response.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-28 — Optional live-performance audio

Dependencies: SS-27. Origin: original (EP-28).

Integrate live input only after measured latency and performer-monitor qualification.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-29 — Session settlement and impact reporting

Dependencies: SS-28. Origin: original (EP-29).

Reconcile artist revenue, costs and independently described participation facts.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-30 — Controlled 10–20-speaker pilot

Dependencies: SS-29. Origin: original (EP-30).

Run a real authorized mixed-device spatial trial with recorded outcomes.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-31 — Larger deployment qualification

Dependencies: SS-30. Origin: original (EP-31).

Increase tested scale in stages and publish limits.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

## SS-32 — Public release and producer runbooks

Dependencies: SS-31. Origin: original (EP-32).

Deliver organizer, performer, operator and contributor guidance with release evidence.

Acceptance: Exercise the stated workflow plus denial, interruption and cross-role cases; publish supported scope and real validation status.

Gate: Actual field evidence for hardware/production claims.

