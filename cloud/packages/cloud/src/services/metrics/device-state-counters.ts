/**
 * Pod-global counters for the device-state storm mitigations in issue 099.
 *
 * Kept in its own module with **no HTTP, auth, or session dependencies** so
 * the metrics layer (SystemVitalsLogger, MemoryTelemetryService) can import
 * it without pulling in the REST route wiring — which would transitively
 * require AUGMENTOS_AUTH_JWT_SECRET at module load and break non-HTTP startup
 * paths such as the cloud test runner.
 *
 * Both DeviceManager (on every updateDeviceState call) and the REST route
 * middleware (on every rate-limit hit) write into these counters. The
 * SystemVitalsLogger tick reads-and-resets them every 30s.
 *
 * See: cloud/issues/099-glasses-connection-state-storm/
 */

let deviceStateUpdatesTotal = 0;
let deviceStateUpdatesDeduped = 0;
let deviceStateUpdatesApplied = 0;
let deviceStateUpdatesRateLimited = 0;

export function incrementDeviceStateTotal(): void {
  deviceStateUpdatesTotal++;
}

export function incrementDeviceStateDeduped(): void {
  deviceStateUpdatesDeduped++;
}

export function incrementDeviceStateApplied(): void {
  deviceStateUpdatesApplied++;
}

export function incrementDeviceStateRateLimited(): void {
  deviceStateUpdatesRateLimited++;
}

export function getDeviceStateCounters(): {
  total: number;
  deduped: number;
  applied: number;
  rateLimited: number;
} {
  return {
    total: deviceStateUpdatesTotal,
    deduped: deviceStateUpdatesDeduped,
    applied: deviceStateUpdatesApplied,
    rateLimited: deviceStateUpdatesRateLimited,
  };
}

export function resetDeviceStateCounters(): void {
  deviceStateUpdatesTotal = 0;
  deviceStateUpdatesDeduped = 0;
  deviceStateUpdatesApplied = 0;
  deviceStateUpdatesRateLimited = 0;
}
