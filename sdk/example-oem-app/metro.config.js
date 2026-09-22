// Learn more https://docs.expo.io/guides/customizing-metro
const {getDefaultConfig} = require("expo/metro-config")
const fs = require("fs")
const path = require("path")

const projectRoot = __dirname
const sdkRoot = path.resolve(projectRoot, "..") // the `sdk` workspace root
const repoRoot = path.resolve(projectRoot, "..", "..") // monorepo root
const modulesRoot = path.resolve(repoRoot, "mobile", "modules")
// The `mobile` bun workspace's own node_modules — where @mentra/engine's
// transitive deps (typesafe-ts, buffer, events, semver, ...) actually live on
// disk, since engine is a member of that workspace, not sdk's. Metro's Node
// resolution walk finds these fine, but Metro also requires the resolved path
// to be inside a watched folder (its Haste/file index) or it 404s as if the
// file didn't exist — so this has to be watched explicitly, not just modulesRoot.
const mobileNodeModulesRoot = path.resolve(repoRoot, "mobile", "node_modules")

const config = getDefaultConfig(projectRoot)

// This app lives in the `sdk` bun workspace (isolated linker), and the Mentra
// SDK packages live under mobile/modules. Metro must watch the workspace store
// (sdk/node_modules/.bun/*) and the modules folder so every symlinked package —
// including transitive deps of `expo` — resolves.
const cloudPackagesRoot = path.resolve(repoRoot, "cloud-v2", "packages")
// Same isolated-linker gap as mobileNodeModulesRoot above, one workspace over:
// cloud-v2/packages/*/node_modules/<pkg> symlinks resolve into
// cloud-v2/node_modules/.bun/*, not anywhere under cloudPackagesRoot.
const cloudNodeModulesRoot = path.resolve(repoRoot, "cloud-v2", "node_modules")

// Only watch folders that exist. Metro's verifyRootExists() throws ENOENT on a
// missing watchFolder, which kills the release bundle outright. A workspace's
// node_modules is only on disk once that workspace has been installed, and the
// OEM APK CI job installs `sdk` alone (engine and the cloud packages are `sdk`
// workspace members, so their deps land in sdk/node_modules/.bun instead).
config.watchFolders = [sdkRoot, modulesRoot, mobileNodeModulesRoot, cloudPackagesRoot, cloudNodeModulesRoot].filter(
  (folder) => fs.existsSync(folder),
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

// Search the app's own node_modules first (so React / React Native resolve to a
// single copy), then the workspace store where bun's isolated linker places the
// real packages and their transitive dependencies.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(sdkRoot, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
]

module.exports = config
