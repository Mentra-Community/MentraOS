const MARKER = "MENTRA_DEBUG_ABI_FILTERS"
const DEBUG_ANCHOR = /(debug\s*\{\s*\n\s*signingConfig signingConfigs\.debug)/

const DEBUG_ABI_BLOCK = `
            // MENTRA_DEBUG_ABI_FILTERS: reactNativeArchitectures only filters RN's own
            // CMake output; prebuilt .so from AAR deps ship every ABI regardless.
            // Honor it here so \`bun android\` stops packaging unused armeabi-v7a.
            ndk {
                def abiList = (findProperty("reactNativeArchitectures") ?: "armeabi-v7a,arm64-v8a,x86,x86_64")
                    .toString()
                    .split(",")
                    .collect { it.trim() }
                    .findAll { !it.isEmpty() }
                abiFilters(*abiList)
            }`

/**
 * Inject a property-derived ndk.abiFilters block into the debug build type only.
 * Release, internal, and defaultConfig are left untouched.
 */
export function withDebugAbiFilters(buildGradle) {
  if (typeof buildGradle !== "string") return buildGradle
  if (buildGradle.includes(MARKER)) return buildGradle
  if (!DEBUG_ANCHOR.test(buildGradle)) return buildGradle
  return buildGradle.replace(DEBUG_ANCHOR, `$1${DEBUG_ABI_BLOCK}`)
}
