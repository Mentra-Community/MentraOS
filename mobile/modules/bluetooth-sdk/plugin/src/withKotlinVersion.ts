import {type ConfigPlugin, withGradleProperties, withProjectBuildGradle} from "expo/config-plugins"

// avif-coder 3.0.0 contains Kotlin 2.3 metadata. Match the standalone SDK
// compiler and @mentra/crust; Expo SDK 55 also has a KSP mapping for 2.3.0.
const MIN_KOTLIN_VERSION = "2.3.0"
const UNVERSIONED_KOTLIN_PLUGIN = "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')"
const PINNED_KOTLIN_PLUGIN = `classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:\${findProperty('android.kotlinVersion')}")`
const ROOT_KOTLIN_VERSION = "ext.kotlinVersion = findProperty('android.kotlinVersion')"
const EXPO_ROOT_PROJECT = 'apply plugin: "expo-root-project"'

function isOlderVersion(version: string) {
  const actual = version.split(".").map(Number)
  const minimum = MIN_KOTLIN_VERSION.split(".").map(Number)
  for (let index = 0; index < minimum.length; index++) {
    if ((actual[index] ?? 0) !== minimum[index]) return (actual[index] ?? 0) < minimum[index]
  }
  return false
}

export const withKotlinVersion: ConfigPlugin = (config) => {
  config = withGradleProperties(config, (cfg) => {
    const property = cfg.modResults.find((item) => item.type === "property" && item.key === "android.kotlinVersion")
    if (property?.type !== "property") {
      cfg.modResults.push({type: "property", key: "android.kotlinVersion", value: MIN_KOTLIN_VERSION})
    } else if (isOlderVersion(property.value)) {
      property.value = MIN_KOTLIN_VERSION
    }
    return cfg
  })

  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") return cfg

    // Expo 55's unversioned classpath resolves React Native's Kotlin 2.1.20
    // compiler even when android.kotlinVersion is set. Pin the actual plugin
    // and Expo's version catalog, as @mentra/crust does for QuickJS.
    let gradle = cfg.modResults.contents.replace(UNVERSIONED_KOTLIN_PLUGIN, PINNED_KOTLIN_PLUGIN)
    if (!gradle.includes(ROOT_KOTLIN_VERSION)) {
      gradle = gradle.replace(
        EXPO_ROOT_PROJECT,
        `// Kotlin compiler required by @mentra/bluetooth-sdk's AVIF decoder.\n${ROOT_KOTLIN_VERSION}\n${EXPO_ROOT_PROJECT}`,
      )
    }
    cfg.modResults.contents = gradle
    return cfg
  })
}
