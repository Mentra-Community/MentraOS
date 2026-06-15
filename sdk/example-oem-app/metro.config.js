// Learn more https://docs.expo.io/guides/customizing-metro
const {getDefaultConfig} = require("expo/metro-config")
const path = require("path")

const projectRoot = __dirname
const sdkRoot = path.resolve(projectRoot, "..") // the `sdk` workspace root
const repoRoot = path.resolve(projectRoot, "..", "..") // monorepo root
const modulesRoot = path.resolve(repoRoot, "mobile", "modules")

const config = getDefaultConfig(projectRoot)

// This app lives in the `sdk` bun workspace (isolated linker), and the Mentra
// SDK packages live under mobile/modules. Metro must watch the workspace store
// (sdk/node_modules/.bun/*) and the modules folder so every symlinked package —
// including transitive deps of `expo` — resolves.
config.watchFolders = [sdkRoot, modulesRoot]

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@mentra/bluetooth-sdk": path.resolve(modulesRoot, "bluetooth-sdk"),
  "@mentra/island": path.resolve(modulesRoot, "island"),
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
