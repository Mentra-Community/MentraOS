import {describe, expect, test} from 'bun:test';

import {otaFlowAdmission} from './otaFlowAdmission';

describe('OTA flow admission', () => {
  test('opens for a newly connected Mentra Live', () => {
    expect(otaFlowAdmission({
      completedConnectionGeneration: null,
      connectionGeneration: 0,
      waitingForWifi: false,
    })).toBe('open');
  });

  test('does not reopen when identity metadata arrives during the same BLE session', () => {
    expect(otaFlowAdmission({
      completedConnectionGeneration: 4,
      connectionGeneration: 4,
      waitingForWifi: false,
    })).toBe('done');
  });

  test('opens again after a disconnect and reconnect advances the BLE session', () => {
    expect(otaFlowAdmission({
      completedConnectionGeneration: 4,
      connectionGeneration: 5,
      waitingForWifi: false,
    })).toBe('open');
  });

  test('keeps Wi-Fi setup open across status refreshes and BLE reconnects', () => {
    for (const connectionGeneration of [0, 0, null, 1]) {
      expect(otaFlowAdmission({
        completedConnectionGeneration: null,
        connectionGeneration,
        waitingForWifi: true,
      })).toBe('wait_for_wifi');
    }
  });

  test('reopens OTA when the user continues from Wi-Fi setup', () => {
    expect(otaFlowAdmission({
      completedConnectionGeneration: null,
      connectionGeneration: 0,
      waitingForWifi: false,
    })).toBe('open');
  });

  test('stays idle when disconnected outside Wi-Fi setup', () => {
    expect(otaFlowAdmission({
      completedConnectionGeneration: null,
      connectionGeneration: null,
      waitingForWifi: false,
    })).toBe('idle');
  });
});
