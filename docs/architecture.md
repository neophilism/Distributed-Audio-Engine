# Four-project development plan

120 planned work packages: 34 Distributed Audio Engine, 32 SceneSignal, 28 Distributed Radio Engine, 26 TrackZero. The original 88-package baseline remains mapped separately; 32 work packages were added. These are roadmap identifiers, not GitHub PR numbers.

Build order requested by the owner: Distributed Audio Engine, SceneSignal, Distributed Radio Engine, TrackZero. The radio engine does not depend on SceneSignal; build order is not an architectural coupling.

Distributed Audio Engine owns neutral encrypted media, device/timing evidence, generic timelines, spatial rendering, scoped controls and reusable commerce/entitlement primitives. SceneSignal consumes it directly. Distributed Radio Engine also consumes it and owns general radio programming, contribution economics, creator-specific wallets and free bonus releases. TrackZero consumes Distributed Radio Engine and supplies consumer/creator experiences.

No organizer event rules or radio-product reward rules belong in the audio core. SceneSignal requires permit evidence or a specific no-permit-required attestation for activated public sessions. TrackZero and the radio engine require no venue, attendance, scheduled gathering or artist proximity.

A **Spime** is a Bluetooth-enabled physical instrument anchor in SceneSignal: its validated location controls a virtual source such as the strings section. Phone, speaker and Spime locations are separate.

All projects adopt the pinned End To End Everywhere architecture as their default. TLS and server disk encryption supplement endpoint encryption; they never substitute for it. Production assurance, native-device and field qualification are evidence gates distinct from merging development code.
