const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const sdkRoot = process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH
  ? path.resolve(process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH)
  : path.dirname(require.resolve('@mentra/bluetooth-sdk/package.json'));

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [sdkRoot],
  resolver: {
    platforms: ['macos', 'ios', 'android'],
    resolveRequest(context, name, platform) {
      if (name === '@mentra/bluetooth-sdk') name = path.join(sdkRoot, 'src/index.ts');
      else if (name.startsWith('@mentra/bluetooth-sdk/')) name = path.join(sdkRoot, 'src', name.slice('@mentra/bluetooth-sdk/'.length));
      if (name === 'react-native' || name.startsWith('react-native/')) name = name.replace('react-native', 'react-native-macos');
      return context.resolveRequest({...context, nodeModulesPaths: [path.join(__dirname, 'node_modules')]}, name, platform);
    },
  },
});
