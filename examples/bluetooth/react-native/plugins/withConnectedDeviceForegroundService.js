const {AndroidConfig, withAndroidManifest} = require('expo/config-plugins');

const SDK_SERVICE = 'com.mentra.bluetoothsdk.services.ForegroundService';
const LOCATION_SERVICE = 'expo.modules.location.services.LocationTaskService';

function applyConnectedDeviceForegroundService(manifest) {
  manifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.service ??= [];

  let service = application.service.find(item => item.$['android:name'] === SDK_SERVICE);
  if (!service) {
    service = {$: {'android:name': SDK_SERVICE}};
    application.service.push(service);
  }
  service.$['android:exported'] = 'false';
  service.$['android:foregroundServiceType'] = 'connectedDevice';
  const replace = new Set((service.$['tools:replace'] || '').split(',').filter(Boolean));
  replace.add('android:foregroundServiceType');
  service.$['tools:replace'] = [...replace].join(',');

  // Engine has an expo-location peer, but this Bluetooth-only host never starts
  // location tasks. Remove its autolinked service without breaking that peer.
  application.service = application.service.filter(item => item.$['android:name'] !== LOCATION_SERVICE);
  application.service.push({$: {'android:name': LOCATION_SERVICE, 'tools:node': 'remove'}});
  return manifest;
}

module.exports = function withConnectedDeviceForegroundService(config) {
  return withAndroidManifest(config, mod => {
    mod.modResults = applyConnectedDeviceForegroundService(mod.modResults);
    return mod;
  });
};

module.exports.applyConnectedDeviceForegroundService = applyConnectedDeviceForegroundService;
