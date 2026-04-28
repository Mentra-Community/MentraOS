const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sdkRoot = process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH
  ? path.resolve(process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH)
  : path.dirname(
      require.resolve("@mentra/bluetooth-sdk/package.json", {
        paths: [projectRoot],
      }),
    );
const sharedPackages = [
  "expo",
  "expo-modules-core",
  "react",
  "react-native",
];
const appPackageRoots = Object.fromEntries(
  sharedPackages.map((packageName) => [
    packageName,
    path.dirname(
      require.resolve(`${packageName}/package.json`, {
        paths: [projectRoot],
      }),
    ),
  ]),
);

const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest;

config.watchFolders = Array.from(
  new Set([...(config.watchFolders || []), sdkRoot]),
);
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  "@mentra/bluetooth-sdk": sdkRoot,
  ...appPackageRoots,
};
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const redirectedModuleName =
    moduleName === "@mentra/bluetooth-sdk"
      ? sdkRoot
      : appPackageRoots[moduleName] ?? moduleName;

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, redirectedModuleName, platform);
  }

  return context.resolveRequest(context, redirectedModuleName, platform);
};
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
