// Shared Android applicationId used by Expo prebuild (app.config.ts) and by
// React Native autolinking (react-native.config.js). The RN resolver only
// reads react-native.config.js; if that file stays on the base package while
// MENTRAOS_BUILD_NAME suffixes applicationId, Gradle reuses a stale
// ReactNativeApplicationEntryPoint that imports the wrong BuildConfig.

const VARIANT_RE = /^[a-zA-Z][a-zA-Z0-9_ ]*$/

function resolveAndroidPackageName({
  region = process.env.EXPO_PUBLIC_DEPLOYMENT_REGION,
  buildName = process.env.MENTRAOS_BUILD_NAME,
} = {}) {
  const base = region === "china" ? "com.mentra.mentra.cn" : "com.mentra.mentra"
  const variantName = typeof buildName === "string" ? buildName.trim() : ""
  if (!variantName || !VARIANT_RE.test(variantName)) return base
  return `${base}.${variantName.toLowerCase().replace(/[^a-zA-Z0-9_]/g, "")}`
}

module.exports = {VARIANT_RE, resolveAndroidPackageName}
