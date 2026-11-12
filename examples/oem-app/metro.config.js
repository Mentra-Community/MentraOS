// Learn more https://docs.expo.io/guides/customizing-metro
const {getDefaultConfig} = require("expo/metro-config")
const fs = require("fs")
const path = require("path")

const projectRoot = __dirname
const repoRoot = path.resolve(projectRoot, "..", "..") // monorepo root
const modulesRoot = path.resolve(repoRoot, "mobile", "modules")
const cloudPackagesRoot = path.resolve(repoRoot, "cloud-v2", "packages")

const config = getDefaultConfig(projectRoot)

// This app is a member of the examples/ Bun workspace (examples/package.json),
// which links the @mentra packages to the SDK source in mobile/modules and
// cloud-v2/packages. Those packages are also members of the root, mobile/,
// cloud-v2/ and sdk/ workspaces, so their node_modules links point into
// whichever workspace store (node_modules/.bun) was installed last. Metro only
// serves files inside watched folders, so keep Expo's defaults and watch every
// store and the source trees. Only watch folders that exist: Metro's
// verifyRootExists() throws ENOENT on a missing watchFolder, which kills the
// release bundle outright.
const workspaceNodeModules = path.resolve(projectRoot, "..", "node_modules")
const sharedFolders = [
  ...["", "examples", "mobile", "cloud-v2", "sdk"].map((workspace) => path.join(repoRoot, workspace, "node_modules")),
  modulesRoot,
  cloudPackagesRoot,
]
config.watchFolders = Array.from(
  new Set([...(config.watchFolders ?? []), ...sharedFolders.filter((folder) => fs.existsSync(folder))]),
)

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  // Every monorepo package engine imports at runtime, mapped explicitly so
  // bundling never depends on which node_modules layout the installer chose
  // (bun's member-planting differs across versions).
  "@mentra/bluetooth-sdk": path.resolve(modulesRoot, "bluetooth-sdk"),
  "@mentra/engine": path.resolve(modulesRoot, "engine"),
  "@mentra/crust": path.resolve(modulesRoot, "crust"),
  "@mentra/jspolyfill": path.resolve(modulesRoot, "jspolyfill"),
  "@mentra/miniapp": path.resolve(modulesRoot, "miniapp"),
  "@mentra/cloud-client": path.resolve(cloudPackagesRoot, "cloud-client"),
  "@mentra/cloud-protocol": path.resolve(cloudPackagesRoot, "protocol"),
}

// Search the app's own node_modules first, then the workspace's.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules"), workspaceNodeModules]

// Another workspace's install can link an SDK package's react or react-native
// to a different copy, which would bundle two Reacts. Resolve these packages,
// and their subpaths, from the app wherever they are imported.
// expo-modules-core is a dependency of expo rather than of the app, so it is
// resolved from expo's own location.
const expoRoot = path.dirname(require.resolve("expo/package.json", {paths: [projectRoot]}))
const singletonOrigins = {
  "react": projectRoot,
  "react-native": projectRoot,
  "expo": projectRoot,
  "expo-modules-core": expoRoot,
}
const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const singleton = Object.keys(singletonOrigins).find(
    (name) => moduleName === name || moduleName.startsWith(`${name}/`),
  )
  const resolveContext = singleton
    ? {...context, originModulePath: path.join(singletonOrigins[singleton], "package.json")}
    : context
  return (defaultResolveRequest ?? context.resolveRequest)(resolveContext, moduleName, platform)
}

module.exports = config
