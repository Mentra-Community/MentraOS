const {getSentryExpoConfig} = require("@sentry/react-native/metro")
const {withUniwindConfig} = require("uniwind/metro")
const path = require("path")
const {withExpoPublicEnvCacheVersion} = require("./scripts/metro-cache-version.cjs")

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
  path.resolve(__dirname, "./modules/engine"),
  path.resolve(__dirname, "./modules/crust"),
  path.resolve(__dirname, "./modules/miniapp"),
  path.resolve(__dirname, "../cloud/packages/types/src"),
  path.resolve(__dirname, "../cloud/packages/display-utils/src"),
  // The aliased cloud-v2 sources must be watched or Metro can't hash them.
  path.resolve(__dirname, "../cloud-v2/packages/protocol/src"),
  path.resolve(__dirname, "../cloud-v2/packages/cloud-client"),
  path.resolve(__dirname, "../cloud-v2/packages/runtime/src"),
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
  // The wire protocol lives in its own leaf package now; the old
  // cloud-runtime/protocol entry is a shim that re-exports it, so both
  // specifiers must resolve.
  "@mentra/cloud-protocol": path.join(CLOUD_V2_PACKAGES, "protocol/src/index.ts"),
  "@mentra/cloud-runtime/protocol": path.join(CLOUD_V2_PACKAGES, "runtime/src/protocol/index.ts"),
}

// Resolve @mentra/engine to its TypeScript SOURCE instead of its compiled
// build/. The engine package's "main" points at build/index.js (it ships as an
// expo-module), so by default Metro bundles the LAST `expo-module build` output,
// not what's in src/. That means a dev edits modules/engine/src, runs the app,
// and silently gets the OLD compiled behavior until they remember to rebuild --
// we hit exactly this (an engine-side rename never took effect; a stale
// "cloud-v2 setSubscriptions failed" string kept showing). Pointing Metro at
// src eliminates that whole class of build-staleness bug: src is always live.
//
// This is safe because the engine src is plain TS that Metro can bundle
// directly -- it has no native android/ios dirs and no codegen/requireNativeModule
// in src, and its workspace deps (@mentra/bluetooth-sdk via its own
// react-native:src field, @mentra/miniapp, @mentra/cloud-runtime/protocol above)
// already resolve for Metro. It mirrors how @mentra/cloud-client is aliased to
// source just above. modules/engine is already in watchFolders, so edits trigger
// fast refresh. (The build/ output is still what gets published for consumers;
// only local dev bundling is redirected here.)
const ENGINE_SRC = path.resolve(__dirname, "./modules/engine/src")
const CRUST_SRC = path.resolve(__dirname, "./modules/crust/src")
const MINIAPP_SRC = path.resolve(__dirname, "./modules/miniapp/src")
const MINIAPP_ALIASES = {
  "@mentra/miniapp": path.join(MINIAPP_SRC, "index"),
  "@mentra/miniapp/background": path.join(MINIAPP_SRC, "background/index"),
  "@mentra/miniapp/ui": path.join(MINIAPP_SRC, "ui/index"),
  "@mentra/miniapp/react": path.join(MINIAPP_SRC, "react/index"),
  "@mentra/miniapp/protocol": path.join(MINIAPP_SRC, "protocol"),
}

// Singleton packages that must NEVER resolve to a nested copy. bun installs
// duplicate react-native/expo under local expo-modules (e.g.
// modules/crust/node_modules/react-native) because they declare them as peer
// deps; if Metro resolves an import from inside such a module to the nested
// copy, the bundle carries a SECOND react-native whose TurboModule specs are
// not wired to the host registry. Symptom (found the hard way): module-eval
// throws "TurboModuleRegistry.getEnforcing('SourceCode') could not be found",
// which silently DROPS any expo-router route whose import chain touches the
// module (cold boots land on "Unmatched Route") and breaks components into
// `undefined`. Forcing these to the app's own copy makes resolution immune to
// install-layout drift.
const SINGLETONS = ["react-native", "expo", "react"]
const singletonPath = Object.fromEntries(SINGLETONS.map((name) => [name, path.resolve(__dirname, "node_modules", name)]))

const baseResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const aliased = CLOUD_V2_ALIASES[moduleName]
  if (aliased) return {type: "sourceFile", filePath: aliased}
  // Subpath imports into the protocol package ("@mentra/cloud-protocol/languages")
  // mirror its package.json "./*": "./src/*.ts" exports map, which Metro does
  // not read. Resolve them to the source file directly.
  if (moduleName.startsWith("@mentra/cloud-protocol/")) {
    const rest = moduleName.slice("@mentra/cloud-protocol/".length)
    return {type: "sourceFile", filePath: path.join(CLOUD_V2_PACKAGES, "protocol/src", `${rest}.ts`)}
  }
  for (const name of SINGLETONS) {
    if (moduleName === name || moduleName.startsWith(`${name}/`)) {
      const target = moduleName === name ? singletonPath[name] : path.join(singletonPath[name], moduleName.slice(name.length + 1))
      return (baseResolveRequest ?? context.resolveRequest)(context, target, platform)
    }
  }
  // @mentra/engine (+ /internal, /devtools, /react) -> TypeScript SOURCE. The package
  // "default" export points at build/, and Metro will happily bundle that stale
  // compile if we only alias the root specifier. LocalMiniappRuntime lives on
  // /internal — that's why miniapp_scan_qr stayed unimplemented until this
  // alias covered the subpath too.
  if (moduleName === "@mentra/engine") {
    return (baseResolveRequest ?? context.resolveRequest)(context, path.join(ENGINE_SRC, "index"), platform)
  }
  if (moduleName === "@mentra/engine/internal") {
    return (baseResolveRequest ?? context.resolveRequest)(context, path.join(ENGINE_SRC, "internal"), platform)
  }
  if (moduleName === "@mentra/engine/devtools") {
    return (baseResolveRequest ?? context.resolveRequest)(context, path.join(ENGINE_SRC, "devtools"), platform)
  }
  if (moduleName === "@mentra/engine/ota") {
    return (baseResolveRequest ?? context.resolveRequest)(context, path.join(ENGINE_SRC, "react/index"), platform)
  }
  const miniappAlias = MINIAPP_ALIASES[moduleName]
  if (miniappAlias) return (baseResolveRequest ?? context.resolveRequest)(context, miniappAlias, platform)
  if (moduleName === "@mentra/crust") {
    return (baseResolveRequest ?? context.resolveRequest)(context, path.join(CRUST_SRC, "index"), platform)
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

// Babel inlines EXPO_PUBLIC_* values, but Metro's default transform cache key
// does not include them. Expo also keeps that cache when CI=true, so concurrent
// builds on our shared runners could reuse transforms from a different release.
config.cacheVersion = withExpoPublicEnvCacheVersion(config.cacheVersion)

module.exports = config
