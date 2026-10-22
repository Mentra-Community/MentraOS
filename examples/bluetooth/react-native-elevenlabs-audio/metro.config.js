const fs = require("fs");
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
// expo-modules-core is a dependency of expo rather than of the app, so with
// an isolated install it is resolved from expo's own location.
const expoRoot = path.dirname(
  require.resolve("expo/package.json", { paths: [projectRoot] }),
);
const singletonOrigins = {
  react: projectRoot,
  "react-native": projectRoot,
  expo: projectRoot,
  "expo-modules-core": expoRoot,
};

const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest;

// Inside MentraOS this app is a member of the examples/ Bun workspace, which
// links the @mentra packages to the SDK source in mobile/modules and
// cloud-v2/packages and keeps npm packages in examples/node_modules. The SDK
// packages are also members of the root, mobile/, cloud-v2/ and sdk/
// workspaces, so their own dependency links point into whichever of those
// stores was installed last. Metro only serves files inside watched folders,
// so watch all of them.
// In a standalone copy of this example every package is under its node_modules.
const repoRoot = path.resolve(projectRoot, "..", "..", "..");
const sourceFolders = [
  ...["", "examples", "mobile", "cloud-v2", "sdk"].map((workspace) =>
    path.join(repoRoot, workspace, "node_modules"),
  ),
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

// Use one copy of React, React Native and Expo: the app's own. Another
// workspace's install can link an SDK package's react or react-native to a
// different copy, so resolve these packages, and their subpaths, from the app
// wherever they are imported.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const singleton = Object.keys(singletonOrigins).find(
    (name) => moduleName === name || moduleName.startsWith(`${name}/`),
  );
  const resolveContext = singleton
    ? {
        ...context,
        originModulePath: path.join(singletonOrigins[singleton], "package.json"),
      }
    : context;

  return (defaultResolveRequest ?? context.resolveRequest)(
    resolveContext,
    moduleName,
    platform,
  );
};
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
