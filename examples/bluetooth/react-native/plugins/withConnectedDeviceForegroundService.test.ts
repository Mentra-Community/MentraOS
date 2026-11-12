import {describe, expect, test} from 'bun:test';
import appConfig from '../app.json';

const {applyConnectedDeviceForegroundService} = require('./withConnectedDeviceForegroundService');
const SDK_SERVICE = 'com.mentra.bluetoothsdk.services.ForegroundService';
const LOCATION_SERVICE = 'expo.modules.location.services.LocationTaskService';

describe('Bluetooth-only Android foreground services', () => {
  test('overrides the SDK type and removes only the unused location service', () => {
    const manifest = {
      manifest: {
        $: {},
        application: [{
          $: {'android:name': '.MainApplication'},
          service: [
            {$: {'android:name': SDK_SERVICE, 'android:foregroundServiceType': 'dataSync|location', 'tools:replace': 'android:exported'}},
            {$: {'android:name': LOCATION_SERVICE, 'android:foregroundServiceType': 'location'}},
            {$: {'android:name': 'another.Service'}},
          ],
        }],
      },
    };
    const result = applyConnectedDeviceForegroundService(manifest);
    const services = result.manifest.application[0].service;
    expect(services.find((item: any) => item.$['android:name'] === SDK_SERVICE).$).toEqual({
      'android:name': SDK_SERVICE,
      'android:exported': 'false',
      'android:foregroundServiceType': 'connectedDevice',
      'tools:replace': 'android:exported,android:foregroundServiceType',
    });
    expect(services.find((item: any) => item.$['android:name'] === LOCATION_SERVICE).$).toEqual({
      'android:name': LOCATION_SERVICE, 'tools:node': 'remove',
    });
    expect(services.some((item: any) => item.$['android:name'] === 'another.Service')).toBe(true);
    expect(applyConnectedDeviceForegroundService(structuredClone(result))).toEqual(result);
  });

  test('creates the override before library manifests are merged', () => {
    const result = applyConnectedDeviceForegroundService({manifest: {$: {}, application: [{$: {'android:name': '.MainApplication'}}]}});
    expect(result.manifest.application[0].service).toHaveLength(2);
    expect(result.manifest.application[0].service[0].$['android:foregroundServiceType']).toBe('connectedDevice');
  });

  test('blocks unused FGS permissions and opts out of Expo background audio', () => {
    expect(appConfig.expo.android.blockedPermissions).toEqual([
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.FOREGROUND_SERVICE_LOCATION',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
      'android.permission.FOREGROUND_SERVICE_MICROPHONE',
    ]);
    expect(appConfig.expo.plugins).toContainEqual(['expo-audio', {
      enableBackgroundPlayback: false,
      enableBackgroundRecording: false,
    }]);
    expect(appConfig.expo.plugins).toContain('./plugins/withConnectedDeviceForegroundService');
    expect(appConfig.expo.ios.infoPlist.UIBackgroundModes).toEqual(['audio']);
  });
});
