# Optional advanced hardware coordinate adapter (DAE-30)

`AdvancedHardwarePositionAdapter` consumes only a platform-validated active hardware coordinate report from an explicitly supported UWB or calibrated-vision tracker. It binds reports to a previously registered physical output and tracker, verifies a monotonically increasing sequence, confidence, uncertainty and freshness through `PlacementRegistry`, and does not infer a speaker position from the owner phone.

BLE discovery or presence and unverified estimates are rejected even if coordinates are included. This API is not a cryptographic authentication layer: the platform integration is responsible for verifying hardware provenance and coordinating calibration. Unsupported models remain unsupported. The associated software tests exercise only contracts and replay/staleness logic; no physical UWB precision, optical tracking accuracy or device compatibility has been field-qualified.
