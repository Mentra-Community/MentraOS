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

// Resolve @mentra/island to its TypeScript SOURCE instead of its compiled
// build/. The island package's "main" points at build/index.js (it ships as an
// expo-module), so by default Metro bundles the LAST `expo-module build` output,
// not what's in src/. That means a dev edits modules/island/src, runs the app,
// and silently gets the OLD compiled behavior until they remember to rebuild --
// we hit exactly this (an island-side rename never took effect; a stale
// "cloud-v2 setSubscriptions failed" string kept showing). Pointing Metro at
// src eliminates that whole class of build-staleness bug: src is always live.
//
// This is safe because the island src is plain TS that Metro can bundle
// directly -- it has no native android/ios dirs and no codegen/requireNativeModule
// in src, and its workspace deps (@mentra/bluetooth-sdk via its own
// react-native:src field, @mentra/miniapp, @mentra/cloud-runtime/protocol above)
// already resolve for Metro. It mirrors how @mentra/cloud-client is aliased to
// source just above. modules/island is already in watchFolders, so edits trigger
// fast refresh. (The build/ output is still what gets published for consumers;
// only local dev bundling is redirected here.)
const ISLAND_SRC = path.resolve(__dirname, "./modules/island/src")

const baseResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const aliased = CLOUD_V2_ALIASES[moduleName]
  if (aliased) return {type: "sourceFile", filePath: aliased}
  // @mentra/island -> src/index.ts; @mentra/island/foo -> src/foo. Let Metro's
  // default resolver (via sourceExts) pick the .ts/.tsx extension off the
  // resulting path so we don't hardcode file extensions here.
  if (moduleName === "@mentra/island") {
    return (baseResolveRequest ?? context.resolveRequest)(context, path.join(ISLAND_SRC, "index"), platform)
  }
  if (moduleName.startsWith("@mentra/island/")) {
    const subpath = moduleName.slice("@mentra/island/".length)
    return (baseResolveRequest ?? context.resolveRequest)(context, path.join(ISLAND_SRC, subpath), platform)
  }
  // @craftzdog/react-native-buffer is backed by the QuickBase64 C++ TurboModule,
  // which is not reliably compiled into local debug builds (getEnforcing throws
  // and breaks the v1 UDP transport). The pure-JS `buffer` package is API-
  // compatible; alias to it so every Buffer user resolves to a dependency that
  // works without the native module.
  if (moduleName === "@craftzdog/react-native-buffer") {
    return (baseResolveRequest ?? context.resolveRequest)(context, "buffer", platform)
  }
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
