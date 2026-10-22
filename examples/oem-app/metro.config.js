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
// cloud-v2/packages. Those packages are also members of the mobile/ and
// cloud-v2/ workspaces, so their node_modules links point into whichever
// workspace store (node_modules/.bun) was installed last. Metro only serves
// files inside watched folders, so keep Expo's defaults and watch every store
// and the source trees. Only watch folders that exist: Metro's
// verifyRootExists() throws ENOENT on a missing watchFolder, which kills the
// release bundle outright.
const workspaceNodeModules = path.resolve(projectRoot, "..", "node_modules")
const sharedFolders = [
  workspaceNodeModules,
  path.resolve(repoRoot, "mobile", "node_modules"),
  path.resolve(repoRoot, "cloud-v2", "node_modules"),
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

// Search the app's own node_modules first so React / React Native resolve to a
// single copy, then the workspace's.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules"), workspaceNodeModules]

module.exports = config
