const {createHash} = require("node:crypto")

function withExpoPublicEnvCacheVersion(baseCacheVersion, env = process.env) {
  const publicEnvironment = Object.entries(env)
    .filter(([key, value]) => key.startsWith("EXPO_PUBLIC_") && value !== undefined)
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right))

  const digest = createHash("sha256").update(JSON.stringify(publicEnvironment)).digest("hex")
  return `${baseCacheVersion ?? "1.0"}:expo-public:${digest}`
}

module.exports = {withExpoPublicEnvCacheVersion}
