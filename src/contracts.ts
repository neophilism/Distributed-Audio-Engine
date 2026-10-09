export const CONTRACT_VERSION = '1.0.0' as const;
export type ApplicationScope = 'scenesignal' | 'distributed-radio';
export type OutputKind = 'bluetooth-speaker' | 'wired-speaker' | 'headphones' | 'internal' | 'unknown';
export interface Scope {
  tenantId: string;
  application: ApplicationScope;
  sessionId: string;
}
export interface Position {
  x: number;
  y: number;
  z: number;
}
export interface OutputRoute {
  endpointId: string;
  routeId: string;
  outputId: string;
  kind: OutputKind;
  generation: number;
}
/** Output telemetry is advisory. It is never acoustic proof by itself. */
export interface AcousticWindow {
  scope: Scope;
  route: OutputRoute;
  fromMs: number;
  toMs: number;
  measuredDbA: number;
  uncertaintyDb: number;
  calibrationId: string;
  sourceAttribution: 'validated' | 'inconclusive';
  evidenceId: string;
}
export type ValidationState = 'planned' | 'implemented' | 'merged' | 'blocked';
export interface CapabilityState {
  implementation: ValidationState;
  deployed: boolean;
  integrationTested: boolean;
  fieldValidated: boolean;
  released: boolean;
}
