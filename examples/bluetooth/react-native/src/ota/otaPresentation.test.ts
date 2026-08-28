import {describe, expect, test} from 'bun:test';
import type {MentraLiveOtaState} from '@mentra/engine/ota';

import {otaPresentation} from './otaPresentation';

const baseState: MentraLiveOtaState = {
  batteryLevel: 80,
  canDiscard: false,
  canDismiss: false,
  canFinish: false,
  canInstall: false,
  canOpenWifiSetup: false,
  canRetry: false,
  completedUpdate: false,
  connected: true,
  continueDisabled: false,
  currentStep: null,
  error: null,
  firmwareRestarting: false,
  hotspotArtifactPercent: null,
  hotspotPhase: 'idle',
  hotspotSupported: true,
  installingApkOnly: false,
  changelogs: [],
  phase: null,
  progress: null,
  releaseTransition: null,
  screen: 'checking',
  step: null,
  totalSteps: null,
  transport: null,
  updateRequired: true,
  versionChange: false,
  versionChangeConverged: false,
  versionChangePhase: null,
  wifiConnected: false,
  wifiStatusKnown: true,
};

function otaState(overrides: Partial<MentraLiveOtaState>): MentraLiveOtaState {
  return {...baseState, ...overrides};
}

describe('custom OTA presentation', () => {
  test('matches the Mentra App checking page copy', () => {
    const presentation = otaPresentation(otaState({screen: 'checking'}));

    expect(presentation).toMatchObject({
      indeterminate: true,
      message: 'Connected devices will perform automatic updates. Automatic updates can be disabled in Device Settings',
      title: 'Checking for updates',
    });
  });

  test('routes a hotspot update through the controller install action', () => {
    const presentation = otaPresentation(otaState({
      canDismiss: true,
      canInstall: true,
      screen: 'update_available',
      transport: 'hotspot',
      updateRequired: false,
    }));

    expect(presentation.primary).toEqual({
      action: 'install',
      disabled: false,
      label: 'Update Now',
    });
    expect(presentation.secondary).toEqual({action: 'finish', label: 'Later'});
    expect(presentation.title).toBe('Mentra Live Update Available');
    expect(presentation.message).toBe(
      'A new update is available for your glasses. We recommend updating now for the best experience.',
    );
    expect(presentation.detail).toBe(
      'Your glasses may install more than one update and restart several times. Keep them nearby until finished.',
    );
  });

  test('shows the current and target coordinated releases before installation', () => {
    const presentation = otaPresentation(otaState({
      canInstall: true,
      releaseTransition: {fromVersion: '40', toVersion: '3.1.0-beta.37'},
      screen: 'update_available',
    }));

    expect(presentation.versionLabel).toBe('40 → 3.1.0-beta.37');
  });

  test('does not invent an unknown current coordinated release', () => {
    const presentation = otaPresentation(otaState({
      releaseTransition: {fromVersion: null, toVersion: '3.1.0-beta.37'},
      screen: 'wifi_required',
    }));

    expect(presentation.versionLabel).toBe('Current version unknown → 3.1.0-beta.37');
  });

  test('does not offer Later for a required update', () => {
    const presentation = otaPresentation(otaState({
      canInstall: true,
      screen: 'update_available',
      updateRequired: true,
    }));

    expect(presentation.primary?.action).toBe('install');
    expect(presentation.secondary).toBeUndefined();
  });

  test('sends legacy glasses to host-owned Wi-Fi setup', () => {
    const presentation = otaPresentation(otaState({
      hotspotSupported: false,
      screen: 'wifi_required',
    }));

    expect(presentation.primary).toEqual({
      action: 'openWifiSetup',
      disabled: false,
      label: 'Setup WiFi',
    });
    expect(presentation.title).toBe('WiFi Needed for Update');
    expect(presentation.message).toBe(
      'Connect your Mentra Live to WiFi to install the update.',
    );
  });

  test('shows phone artifact progress without implementing transport logic', () => {
    const presentation = otaPresentation(otaState({
      hotspotArtifactPercent: 42,
      hotspotPhase: 'downloading',
      screen: 'preparing_hotspot',
      transport: 'hotspot',
    }));

    expect(presentation.title).toBe('Downloading update to phone...');
    expect(presentation.progress).toBe(42);
    expect(presentation.indeterminate).toBe(true);
    expect(presentation.message).toBe('Do not disconnect your glasses');
    expect(presentation.primary).toBeUndefined();
  });

  test('does not expose coordinator implementation details in customer copy', () => {
    const presentation = otaPresentation(otaState({
      currentStep: 2,
      phase: 'install',
      progress: 68,
      screen: 'updating',
      step: 'mtk',
      totalSteps: 3,
    }));

    expect(presentation.title).toBe('Installing...');
    expect(presentation.detail).toBeUndefined();
    expect(presentation.message).toBe('Do not disconnect your glasses');
    expect(presentation.progress).toBe(68);
  });

  test('keeps update progress indeterminate until Engine reports a percentage', () => {
    const presentation = otaPresentation(otaState({
      phase: 'install',
      progress: null,
      screen: 'updating',
    }));

    expect(presentation.indeterminate).toBe(true);
    expect(presentation.progress).toBeUndefined();
  });

  test('uses only retry and Wi-Fi controller actions after a recoverable failure', () => {
    const presentation = otaPresentation(otaState({
      canOpenWifiSetup: true,
      canRetry: true,
      error: {code: 'install_failed', message: 'Download failed'},
      screen: 'failed',
    }));

    expect(presentation.primary?.action).toBe('retryInstall');
    expect(presentation.secondary?.action).toBe('openWifiSetup');
    expect(presentation.message).toBe('Download failed');
  });

  test('does not expose Finish when Engine has no valid failure action', () => {
    const presentation = otaPresentation(otaState({
      canFinish: false,
      canRetry: false,
      error: {code: 'install_failed', message: 'Update unavailable'},
      screen: 'failed',
    }));

    expect(presentation.primary).toBeUndefined();
  });

  test('keeps a failed update check on the stock retry-only action', () => {
    const presentation = otaPresentation(otaState({
      canRetry: true,
      error: {code: 'check_failed', message: 'Network unavailable'},
      screen: 'check_failed',
    }));

    expect(presentation.primary).toEqual({action: 'retryCheck', label: 'Retry'});
    expect(presentation.secondary).toBeUndefined();
    expect(presentation.message).toBe(
      "Couldn't check for updates. Please check your connection and try again.",
    );
  });

  test('keeps intermediate completion in the active finishing state', () => {
    const presentation = otaPresentation(otaState({
      changelogs: [{version: '3.1.0', markdown: 'Release notes'}],
      screen: 'finishing',
    }));

    expect(presentation).toMatchObject({
      indeterminate: true,
      title: 'Finishing your update',
      tone: 'active',
    });
    expect(presentation.primary).toBeUndefined();
    expect(presentation.changelogs).toBeUndefined();
  });

  test('blocks installation until the glasses battery reaches the OTA minimum', () => {
    const presentation = otaPresentation(otaState({
      batteryLevel: 18,
      canDismiss: true,
      screen: 'battery_required',
    }));

    expect(presentation).toMatchObject({
      detail: 'This screen will update automatically as the battery charges.',
      message: 'Mentra Live is currently at 18%. Charge it to at least 25% before updating.',
      primary: {action: 'install', disabled: true, label: 'Update Now'},
      secondary: {action: 'finish', label: 'Later'},
      title: 'Charge Mentra Live to Update',
      tone: 'neutral',
    });
  });

  test('finishes only after Engine reports the final up-to-date state', () => {
    const presentation = otaPresentation(otaState({
      changelogs: [
        {version: '3.2.0', markdown: 'Newest notes'},
        {version: '3.1.0', markdown: 'Earlier notes'},
      ],
      completedUpdate: true,
      releaseTransition: {fromVersion: '40', toVersion: '3.2.0'},
      screen: 'up_to_date',
    }));

    expect(presentation.primary).toEqual({action: 'finish', label: 'Done'});
    expect(presentation.changelogs?.map(({version}) => version)).toEqual([
      '3.2.0',
      '3.1.0',
    ]);
    expect(presentation.tone).toBe('success');
    expect(presentation.title).toBe('Update complete');
    expect(presentation.versionLabel).toBe('Updated to 3.2.0');
  });

  test('keeps changelogs on the stable up-to-date screen', () => {
    const presentation = otaPresentation(otaState({
      changelogs: [{version: '3.1.0', markdown: 'Release notes'}],
      screen: 'up_to_date',
    }));

    expect(presentation.changelogs).toEqual([
      {version: '3.1.0', markdown: 'Release notes'},
    ]);
    expect(presentation.primary).toEqual({
      action: 'finish',
      label: 'Continue',
    });
  });

  test('shows completed-session copy without requiring a release label', () => {
    const presentation = otaPresentation(otaState({
      completedUpdate: true,
      releaseTransition: null,
      screen: 'up_to_date',
    }));

    expect(presentation.primary).toEqual({action: 'finish', label: 'Done'});
    expect(presentation.title).toBe('Update complete');
    expect(presentation.versionLabel).toBeUndefined();
  });

  test('keeps only the example-specific dev setup instruction', () => {
    const presentation = otaPresentation(otaState({screen: 'dev_build'}));

    expect(presentation).toMatchObject({
      detail: 'Set EXPO_PUBLIC_ASG_OTA_VERSION_URL when you intentionally want to test an OTA manifest.',
      message: 'This mobile app is a development build, so automatic glasses updates are disabled.',
      title: 'Development Build',
    });
  });
});
