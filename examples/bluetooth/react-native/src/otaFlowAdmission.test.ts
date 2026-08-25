import {describe, expect, test} from 'bun:test';

import {otaFlowAdmission} from './otaFlowAdmission';

describe('OTA flow admission', () => {
  test('opens for a newly connected Mentra Live', () => {
    expect(otaFlowAdmission({
      completedConnectionGeneration: null,
      connectionGeneration: 0,
      waitingForWifi: false,
      wifiConnected: false,
    })).toBe('open');
  });

  test('does not reopen when identity metadata arrives during the same BLE session', () => {
    expect(otaFlowAdmission({
      completedConnectionGeneration: 4,
      connectionGeneration: 4,
      waitingForWifi: false,
      wifiConnected: true,
    })).toBe('done');
  });

  test('opens again after a disconnect and reconnect advances the BLE session', () => {
    expect(otaFlowAdmission({
      completedConnectionGeneration: 4,
      connectionGeneration: 5,
      waitingForWifi: false,
      wifiConnected: true,
    })).toBe('open');
  });

  test('waits in System until legacy Wi-Fi setup completes', () => {
    expect(otaFlowAdmission({
      completedConnectionGeneration: null,
      connectionGeneration: 0,
      waitingForWifi: true,
      wifiConnected: false,
    })).toBe('wait_for_wifi');
    expect(otaFlowAdmission({
      completedConnectionGeneration: null,
      connectionGeneration: 0,
      waitingForWifi: true,
      wifiConnected: true,
    })).toBe('open');
  });
});
