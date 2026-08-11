import {describe, expect, test} from 'bun:test';
import type {OtaStatusEvent} from '@mentra/bluetooth-sdk';
import {
  buildStalledOtaFailure,
  isOtaProgressActive,
  otaProgressFingerprint,
} from './otaProgressPolicy';

const status: OtaStatusEvent = {
  type: 'ota_status',
  session_id: 'session-1',
  total_steps: 2,
  current_step: 1,
  step_type: 'apk',
  phase: 'install',
  step_percent: 0,
  overall_percent: 20,
  status: 'in_progress',
};

describe('OTA progress policy', () => {
  test('does not treat duplicate events as progress', () => {
    expect(otaProgressFingerprint({...status})).toBe(otaProgressFingerprint(status));
  });

  test('rearms for meaningful progress and phase changes', () => {
    expect(otaProgressFingerprint({...status, step_percent: 1})).not.toBe(
      otaProgressFingerprint(status),
    );
    expect(otaProgressFingerprint({...status, step_type: 'bes', current_step: 2})).not.toBe(
      otaProgressFingerprint(status),
    );
  });

  test('watches only nonterminal OTA states', () => {
    expect(isOtaProgressActive(status)).toBe(true);
    expect(isOtaProgressActive({...status, status: 'step_complete'})).toBe(true);
    expect(isOtaProgressActive({...status, status: 'complete'})).toBe(false);
    expect(isOtaProgressActive({...status, status: 'failed'})).toBe(false);
    expect(isOtaProgressActive({...status, status: 'idle'})).toBe(false);
  });

  test('preserves session and progress context in a synthetic stall failure', () => {
    const failed = buildStalledOtaFailure(status, 'The manifest still reports an update.');

    expect(failed).toMatchObject({
      session_id: 'session-1',
      current_step: 1,
      step_type: 'apk',
      overall_percent: 20,
      status: 'failed',
    });
    expect(failed.error_message).toContain('The manifest still reports an update.');
  });
});
