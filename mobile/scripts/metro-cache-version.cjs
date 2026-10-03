const {createHash} = require("node:crypto")

// Stamped fresh every `bun android` for the debug overlay. Minute-granularity,
// so hashing it forces a full-graph cold transform on every rebuild while no
// real configuration changed. Correspondingly omitted from
// RELEASE_BUNDLE_ENV_KEYS — a cache-reused bundle may carry a prior timestamp,
// and EXPO_PUBLIC_BUILD_COMMIT remains the authoritative build identity.
const CACHE_IRRELEVANT_PUBLIC_KEYS = new Set(["EXPO_PUBLIC_BUILD_TIME"])

function withExpoPublicEnvCacheVersion(baseCacheVersion, env = process.env) {
  const publicEnvironment = Object.entries(env)
    .filter(
      ([key, value]) =>
        key.startsWith("EXPO_PUBLIC_") &&
        value !== undefined &&
        !CACHE_IRRELEVANT_PUBLIC_KEYS.has(key),
    )
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right))

  const digest = createHash("sha256").update(JSON.stringify(publicEnvironment)).digest("hex")
  return `${baseCacheVersion ?? "1.0"}:expo-public:${digest}`
}

module.exports = {withExpoPublicEnvCacheVersion}
