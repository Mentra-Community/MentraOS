import {describe, expect, test} from 'bun:test';

import {otaFlowAdmission} from './otaFlowAdmission';

describe('OTA flow admission', () => {
  test('opens for a newly connected Mentra Live', () => {
    expect(otaFlowAdmission({
      completedConnectionKey: null,
      connectionKey: 'live-1',
      waitingForWifi: false,
      wifiConnected: false,
    })).toBe('open');
  });

  test('does not reopen after the same connection completed', () => {
    expect(otaFlowAdmission({
      completedConnectionKey: 'live-1',
      connectionKey: 'live-1',
      waitingForWifi: false,
      wifiConnected: true,
    })).toBe('done');
  });

  test('waits in System until legacy Wi-Fi setup completes', () => {
    expect(otaFlowAdmission({
      completedConnectionKey: null,
      connectionKey: 'live-1',
      waitingForWifi: true,
      wifiConnected: false,
    })).toBe('wait_for_wifi');
    expect(otaFlowAdmission({
      completedConnectionKey: null,
      connectionKey: 'live-1',
      waitingForWifi: true,
      wifiConnected: true,
    })).toBe('open');
  });
});
