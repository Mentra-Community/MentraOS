const fs = require('fs');
const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

// Inside MentraOS, @mentra/bluetooth-sdk is a Bun workspace link to the SDK
// source in mobile/modules, with its @mentra/cloud-protocol dependency in
// cloud-v2/packages and npm dependencies in the sdk/ workspace store. Metro
// only serves files inside watched folders, so watch those trees. In a
// standalone copy of this example every package is under node_modules.
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const watchFolders = fs.existsSync(path.join(repoRoot, 'mobile', 'modules', 'bluetooth-sdk'))
  ? [
      path.join(repoRoot, 'mobile', 'modules'),
      path.join(repoRoot, 'cloud-v2', 'packages'),
      path.join(repoRoot, 'sdk', 'node_modules'),
    ].filter(folder => fs.existsSync(folder))
  : [];

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders,
  resolver: {
    platforms: ['macos', 'ios', 'android'],
    unstable_enableSymlinks: true,
    resolveRequest(context, name, platform) {
      if (name === 'react-native' || name.startsWith('react-native/')) name = name.replace('react-native', 'react-native-macos');
      return context.resolveRequest({...context, nodeModulesPaths: [path.join(__dirname, 'node_modules')]}, name, platform);
    },
  },
});
