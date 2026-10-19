import type { PositionObservation, TrackingPolicy } from './placement.js';
import { PlacementRegistry } from './placement.js';
import { finite, identifier, integer, invariant } from './validation.js';

/** Platform-integrator verified observations only; this class does not authenticate radio hardware. */
export interface HardwareLocationReport {
  origin: 'trusted-native-coordinate' | 'ble-presence' | 'unverified-estimate';
  hardware: 'uwb' | 'calibrated-vision' | 'ble';
  objectId: string;
  trackerId: string;
  sequence: number;
  atMs: number;
  x: number;
  y: number;
  z: number;
  uncertaintyMeters: number;
  confidence: number;
}
export class AdvancedHardwarePositionAdapter {
  readonly placements: PlacementRegistry;
  private readonly trustedCapabilities: ReadonlySet<string>;
  constructor(policy: TrackingPolicy, supportedHardware: readonly ('uwb' | 'calibrated-vision')[]) {
    invariant(Array.isArray(supportedHardware) && supportedHardware.length > 0 &&
      supportedHardware.length <= 2 && new Set(supportedHardware).size === supportedHardware.length &&
      supportedHardware.every(v => v === 'uwb' || v === 'calibrated-vision'),
      'INVALID_HARDWARE_CAPABILITIES');
    this.trustedCapabilities = new Set(supportedHardware);
    this.placements = new PlacementRegistry(policy);
  }
  observe(report: HardwareLocationReport, nowMs: number): void {
    invariant(report && typeof report === 'object' &&
      Object.keys(report).sort().join(',') ===
      'atMs,confidence,hardware,objectId,origin,sequence,trackerId,uncertaintyMeters,x,y,z',
      'INVALID_HARDWARE_REPORT');
    identifier(report.objectId); identifier(report.trackerId);
    invariant(report.origin === 'trusted-native-coordinate' &&
      this.trustedCapabilities.has(report.hardware) && report.hardware !== 'ble',
      'HARDWARE_COORDINATE_UNVERIFIED');
    integer(report.sequence, 1); integer(report.atMs, 0); integer(nowMs, 0);
    finite(report.uncertaintyMeters, 0); finite(report.confidence, 0, 1);
    const observation: PositionObservation = {
      objectId: report.objectId, trackerId: report.trackerId, sequence: report.sequence,
      atMs: report.atMs, position: { x: report.x, y: report.y, z: report.z },
      uncertaintyMeters: report.uncertaintyMeters, confidence: report.confidence,
      method: 'validated-coordinate'
    };
    this.placements.observe(observation, nowMs);
  }
}
