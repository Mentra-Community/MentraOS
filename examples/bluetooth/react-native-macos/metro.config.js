const fs = require('fs');
const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

// Inside MentraOS this app is a member of the examples/ Bun workspace, which
// links @mentra/bluetooth-sdk and @mentra/cloud-protocol to the SDK source in
// mobile/modules and cloud-v2/packages and keeps npm packages in
// examples/node_modules. The SDK packages are also members of the root,
// mobile/, cloud-v2/ and sdk/ workspaces, so their own dependency links point into whichever of
// those stores was installed last. Metro only serves files inside watched
// folders, so watch all of them. In a standalone copy every package is under
// node_modules.
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const watchFolders = fs.existsSync(path.join(repoRoot, 'mobile', 'modules', 'bluetooth-sdk'))
  ? [
      ...['', 'examples', 'mobile', 'cloud-v2', 'sdk'].map(workspace => path.join(repoRoot, workspace, 'node_modules')),
      path.join(repoRoot, 'mobile', 'modules'),
      path.join(repoRoot, 'cloud-v2', 'packages'),
    ].filter(folder => fs.existsSync(folder))
  : [];

// Resolve React, React Native macOS and Expo from the app wherever they are
// imported: another workspace's install can link an SDK package's react to a
// different copy. expo-modules-core is a dependency of expo rather than of
// the app, so it is resolved from expo's own location.
const expoRoot = path.dirname(require.resolve('expo/package.json', {paths: [__dirname]}));
const singletonOrigins = {
  react: __dirname,
  'react-native-macos': __dirname,
  expo: __dirname,
  'expo-modules-core': expoRoot,
};

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders,
  resolver: {
    platforms: ['macos', 'ios', 'android'],
    unstable_enableSymlinks: true,
    resolveRequest(context, name, platform) {
      if (name === 'react-native' || name.startsWith('react-native/')) name = name.replace('react-native', 'react-native-macos');
      const singleton = Object.keys(singletonOrigins).find(pkg => name === pkg || name.startsWith(`${pkg}/`));
      const origin = singleton ? {originModulePath: path.join(singletonOrigins[singleton], 'package.json')} : {};
      return context.resolveRequest({...context, ...origin, nodeModulesPaths: [path.join(__dirname, 'node_modules')]}, name, platform);
    },
  },
});
