import {describe, expect, test} from 'bun:test';
import type {Device} from '@mentra/engine/bluetooth-sdk';
import type {MentraLivePairingState} from '@mentra/engine/pairing';

import {pairingPresentation} from './pairingPresentation';

const device = {id: 'a', name: 'MENTRA_LIVE_BLE_E511', model: 'Mentra Live', address: 'a'} as Device;

describe('pairingPresentation', () => {
  test('prep continues to the scan or cancels', () => {
    const presentation = pairingPresentation({page: 'prep'});
    expect(presentation.primary).toEqual({action: 'continueToScan', label: 'Continue'});
    expect(presentation.secondary?.action).toBe('back');
  });

  test('lists glasses by code', () => {
    const state: MentraLivePairingState = {
      page: 'scan',
      status: 'choosing',
      scanning: true,
      glasses: [
        {id: 'a', label: 'E511', device},
        {id: 'b', label: 'B2C4', device: {...device, id: 'b'}},
      ],
    };
    const presentation = pairingPresentation(state);
    expect(presentation.rows?.map((row) => row.label)).toEqual(['Mentra Live E511', 'Mentra Live B2C4']);
    expect(presentation.indeterminate).toBe(true);
    expect(presentation.primary).toBeUndefined();
  });

  test('offers Scan again once the scan stops', () => {
    for (const status of ['not_found', 'in_use'] as const) {
      const presentation = pairingPresentation({
        page: 'scan',
        status,
        scanning: false,
        glasses: [],
      });
      expect(presentation.primary?.action).toBe('scanAgain');
      expect(presentation.tone).toBe('danger');
    }
  });

  test('asks before cancelling Pair Audio only during an attempt', () => {
    const base = {page: 'pair_audio', deviceName: 'MENTRA_LIVE_BLE_E511', otherAudioConnected: false} as const;
    expect(pairingPresentation({...base, canCancel: true}).confirmCancel).toBe(true);
    expect(pairingPresentation({...base, canCancel: false}).confirmCancel).toBe(false);
  });

  test('explains known failures and falls back for others', () => {
    expect(pairingPresentation({page: 'failure', error: 'errors:pairingBatteryTooLow'}).message).toContain('25%');
    expect(pairingPresentation({page: 'failure', error: 'pairing:failed'}).message).toBe('Pairing failed. Try again.');
    expect(pairingPresentation({page: 'success'}).primary?.action).toBe('finish');
  });
});
