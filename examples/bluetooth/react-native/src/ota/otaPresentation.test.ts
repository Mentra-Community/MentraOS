import {describe, expect, test} from 'bun:test';

import {otaPresentation, type CustomOtaState} from './otaPresentation';

const baseState: CustomOtaState = {
  canDiscard: false,
  canDismiss: false,
  canFinish: false,
  canInstall: false,
  canOpenWifiSetup: false,
  canRetry: false,
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

function otaState(overrides: Partial<CustomOtaState>): CustomOtaState {
  return {...baseState, ...overrides};
}

describe('custom OTA presentation', () => {
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
      label: 'Update now',
    });
    expect(presentation.secondary).toEqual({action: 'finish', label: 'Later'});
    expect(presentation.detail).toContain('glasses hotspot');
    expect(presentation.message).toContain('more than one update');
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
      label: 'Set up Wi-Fi',
    });
  });

  test('shows phone artifact progress without implementing transport logic', () => {
    const presentation = otaPresentation(otaState({
      hotspotArtifactPercent: 42,
      hotspotPhase: 'downloading',
      screen: 'preparing_hotspot',
      transport: 'hotspot',
    }));

    expect(presentation.title).toBe('Downloading update to phone');
    expect(presentation.progress).toBe(42);
    expect(presentation.primary).toBeUndefined();
  });

  test('renders coordinator step and progress fields', () => {
    const presentation = otaPresentation(otaState({
      currentStep: 2,
      phase: 'install',
      progress: 68,
      screen: 'updating',
      step: 'mtk',
      totalSteps: 3,
    }));

    expect(presentation.title).toBe('Installing system software');
    expect(presentation.detail).toBe('Step 2 of 3: system software');
    expect(presentation.progress).toBe(68);
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

  test('keeps a failed update check on the stock retry-only action', () => {
    const presentation = otaPresentation(otaState({
      canRetry: true,
      error: {code: 'check_failed', message: 'Network unavailable'},
      screen: 'check_failed',
    }));

    expect(presentation.primary).toEqual({action: 'retryCheck', label: 'Try again'});
    expect(presentation.secondary).toBeUndefined();
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

  test('finishes only after Engine reports the final up-to-date state', () => {
    const presentation = otaPresentation(otaState({
      changelogs: [
        {version: '3.2.0', markdown: 'Newest notes'},
        {version: '3.1.0', markdown: 'Earlier notes'},
      ],
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
});
