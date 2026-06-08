const {getSentryExpoConfig} = require("@sentry/react-native/metro")
const {withUniwindConfig} = require("uniwind/metro")
const path = require("path")

/** @type {import('expo/metro-config').MetroConfig} */
var config = getSentryExpoConfig(__dirname)

// Configure SVG transformer
config.transformer = {
  ...config.transformer,
  babelTransformerPath: require.resolve("react-native-svg-transformer"),
}

config.transformer.getTransformOptions = async () => ({
  transform: {
    // Inline requires are very useful for deferring loading of large dependencies/components.
    // For example, we use it in app.tsx to conditionally load Reactotron.
    // However, this comes with some gotchas.
    // Read more here: https://reactnative.dev/docs/optimizing-javascript-loading
    // And here: https://github.com/expo/expo/issues/27279#issuecomment-1971610698
    inlineRequires: true,
  },
})

// Configure resolver for SVG files
config.resolver.assetExts = config.resolver.assetExts.filter((ext) => ext !== "svg")
config.resolver.sourceExts = [...config.resolver.sourceExts, "svg"]

// Add HTML to asset extensions
config.resolver.assetExts = [...config.resolver.assetExts, "html"]

// Watch the core and cloud modules for changes
config.watchFolders = [
  path.resolve(__dirname, "./modules/bluetooth-sdk"),
  path.resolve(__dirname, "./modules/island"),
  path.resolve(__dirname, "./modules/miniapp"),
  path.resolve(__dirname, "../cloud/packages/types/src"),
  path.resolve(__dirname, "../cloud/packages/display-utils/src"),
]

// Resolve the core module from the parent directory
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.resolve(__dirname, "..")]

// Resolve the v2 cloud-client + protocol types from the sibling cloud-v2
// workspace by explicit alias. The two repos are separate bun workspaces, so a
// normal dependency would hit cloud-client's `workspace:*` refs; aliasing the
// exact import specifiers to their source files sidesteps that and the package
// `exports` map. Only the pure client + protocol are bundled here; the runtime
// server root (`@mentra/cloud-runtime`) is never imported, so its node-only
// deps never reach the bundle.
const CLOUD_V2_PACKAGES = path.resolve(__dirname, "../cloud-v2/packages")
const CLOUD_V2_ALIASES = {
  "@mentra/cloud-client": path.join(CLOUD_V2_PACKAGES, "cloud-client/src/index.ts"),
  "@mentra/cloud-client/react-native": path.join(CLOUD_V2_PACKAGES, "cloud-client/react-native/index.ts"),
  "@mentra/cloud-runtime/protocol": path.join(CLOUD_V2_PACKAGES, "runtime/src/protocol/index.ts"),
}
const baseResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const aliased = CLOUD_V2_ALIASES[moduleName]
  if (aliased) return {type: "sourceFile", filePath: aliased}
  return (baseResolveRequest ?? context.resolveRequest)(context, moduleName, platform)
}
config.watchFolders.push(
  path.resolve(__dirname, "../cloud-v2/packages/cloud-client"),
  path.resolve(__dirname, "../cloud-v2/packages/runtime/src/protocol"),
)

config = withUniwindConfig(config, {
  // relative path to your global.css file (from previous step)
  cssEntryFile: "./src/global.css",
  // (optional) path where we gonna auto-generate typings
  // defaults to project's root
  dtsFile: "./src/uniwind-types.d.ts",
})

module.exports = config
