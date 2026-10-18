# Device profiles and route evidence (DAE-12)

`DeviceRouteProfiles` accepts only a **trusted native-active-output callback**. An OS pairing list, device alias, advertisement, or displayed headphone name must not enter via that callback. Producers are responsible for authenticating their native bridge and validating that the report identifies the **actual active** output, not merely a connected or paired device.

A route has a monotonically increasing generation. Each accepted native output transition invalidates playback and acoustic evidence using the supplied callback. Interruption and disconnect also invalidate and clear capabilities; older generations cannot be reused. Route observations identify supported *playback* capabilities, never verified speaker presence or emitted sound.

All profile snapshots carry `speakerProven: false` and `acousticQualification: 'unknown'`. Real-world speaker proof requires a separate opt-in captured measurement, calibrated and attributed to the output, validated by the evidence pipeline; simulation, route names, or this API cannot promote the claim. Applications must treat unavailable, interrupted, mismatched and unsupported playback routes as not qualified.

Software tests exercise rejection of pairing/name provenance, duplicate capabilities, generation rollback and immediate evidence invalidation. They are **not** field hardware validation.
