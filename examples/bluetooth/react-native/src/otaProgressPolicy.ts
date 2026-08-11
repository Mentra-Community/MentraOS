import type {OtaStatusEvent} from '@mentra/bluetooth-sdk';

// Match the Mentra App's progress-stall threshold while keeping this example independent
// from the app-only OTA coordinator.
export const OTA_PROGRESS_TIMEOUT_MS = 120_000;

export function isOtaProgressActive(status: OtaStatusEvent | null) {
  return status?.status === 'in_progress' || status?.status === 'step_complete';
}

export function otaProgressFingerprint(status: OtaStatusEvent) {
  return [
    status.session_id || 'current-ota',
    status.current_step,
    status.total_steps,
    status.step_type,
    status.phase,
    status.step_percent,
    status.overall_percent,
    status.status,
  ].join('|');
}

export function buildStalledOtaFailure(
  status: OtaStatusEvent,
  detail: string,
): OtaStatusEvent {
  return {
    ...status,
    status: 'failed',
    error_message: `No OTA progress was received for two minutes. ${detail}`,
  };
}
