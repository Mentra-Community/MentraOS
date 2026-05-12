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
  path.resolve(__dirname, "./modules/core"),
  path.resolve(__dirname, "../cloud/packages/types/src"),
  path.resolve(__dirname, "../cloud/packages/display-utils/src"),
]

// Resolve the core module from the parent directory
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.resolve(__dirname, "..")]

config = withUniwindConfig(config, {
  // relative path to your global.css file (from previous step)
  cssEntryFile: "./src/global.css",
  // (optional) path where we gonna auto-generate typings
  // defaults to project's root
  dtsFile: "./src/uniwind-types.d.ts",
})

// Rewrite legacy `event-target-shim/index` imports to the package root.
// @livekit/react-native(-webrtc) ships compiled output that imports
// `event-target-shim/index`, but event-target-shim@6 only exposes `.` in its
// `exports` map, which Metro's package-exports resolver then warns about and
// falls back to file-based resolution for. Aliasing here silences the warning
// and avoids the extra fallback work on every cold start.
//
// IMPORTANT: install this last so it wraps any resolver Uniwind/Sentry installed.
const previousResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "event-target-shim/index" || moduleName === "event-target-shim/index.js") {
    return context.resolveRequest(context, "event-target-shim", platform)
  }
  if (typeof previousResolveRequest === "function") {
    return previousResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
