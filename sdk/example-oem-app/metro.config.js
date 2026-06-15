// Learn more https://docs.expo.io/guides/customizing-metro
const {getDefaultConfig} = require("expo/metro-config")
const path = require("path")

const projectRoot = __dirname
const modulesRoot = path.resolve(projectRoot, "..", "..", "mobile", "modules")

const config = getDefaultConfig(projectRoot)

// The Mentra SDK packages live in the monorepo under mobile/modules and are
// consumed straight from there, so Metro must watch that folder and be able to
// resolve the @mentra/* specifiers to it.
config.watchFolders = [modulesRoot]

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@mentra/bluetooth-sdk": path.resolve(modulesRoot, "bluetooth-sdk"),
  "@mentra/island": path.resolve(modulesRoot, "island"),
}

// Resolve React / React Native (and the SDKs' own deps) from this app's
// node_modules first. Pulling a second copy of React from a parent workspace
// bundles two React instances and crashes hooks at runtime.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(modulesRoot, "bluetooth-sdk", "node_modules"),
  path.resolve(modulesRoot, "island", "node_modules"),
]

module.exports = config
