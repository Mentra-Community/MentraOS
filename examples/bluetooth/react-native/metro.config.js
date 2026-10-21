const fs = require("fs");
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sharedPackages = [
  "expo",
  "expo-modules-core",
  "react",
  "react-native",
];
// expo-modules-core is a dependency of expo rather than of the app, so with
// an isolated install it is resolved from expo's own location.
const expoRoot = path.dirname(
  require.resolve("expo/package.json", { paths: [projectRoot] }),
);
const appPackageRoots = Object.fromEntries(
  sharedPackages.map((packageName) => [
    packageName,
    path.dirname(
      require.resolve(`${packageName}/package.json`, {
        paths: [projectRoot, expoRoot],
      }),
    ),
  ]),
);

const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest;

// Inside MentraOS this app is a member of the examples/ Bun workspace, which
// links the @mentra packages to the SDK source in mobile/modules and
// cloud-v2/packages and keeps npm packages in examples/node_modules. Metro
// only serves files inside watched folders, so watch those trees. In a
// standalone copy of this example every package is under its node_modules.
const repoRoot = path.resolve(projectRoot, "..", "..", "..");
const sourceFolders = [
  path.join(repoRoot, "examples", "node_modules"),
  path.join(repoRoot, "mobile", "modules"),
  path.join(repoRoot, "cloud-v2", "packages"),
];
if (fs.existsSync(path.join(repoRoot, "mobile", "modules", "bluetooth-sdk"))) {
  config.watchFolders = Array.from(
    new Set([
      ...(config.watchFolders || []),
      ...sourceFolders.filter((folder) => fs.existsSync(folder)),
    ]),
  );
}

// Use one copy of React, React Native and Expo: the app's own.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  ...appPackageRoots,
};
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const redirectedModuleName = appPackageRoots[moduleName] ?? moduleName;

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, redirectedModuleName, platform);
  }

  return context.resolveRequest(context, redirectedModuleName, platform);
};
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
