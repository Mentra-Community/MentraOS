import {
  withAppBuildGradle,
  withGradleProperties,
  withProjectBuildGradle,
  type ConfigPlugin,
  type ExportedConfig,
} from "expo/config-plugins"

interface CrustAndroidOptions {
  navigation: boolean
}

// Marker comments double as idempotency checks: each injection looks for its
// OWN unique marker (never a shared substring — a marker one block contains
// can silently mask another block's check).
const MAPBOX_REPO_MARKER = "mapbox: navigation sdk downloads repo (injected by @mentra/crust)"
const MAPBOX_REPO = [
  "    maven {",
  `      // ${MAPBOX_REPO_MARKER}`,
  "      url 'https://api.mapbox.com/downloads/v2/releases/maven'",
  "      authentication { basic(BasicAuthentication) }",
  "      credentials {",
  "        username = 'mapbox'",
  "        password = System.getenv('MAPBOX_DOWNLOADS_TOKEN') ?: (findProperty('MAPBOX_DOWNLOADS_TOKEN') ?: '')",
  "      }",
  "    }",
].join("\n")

const PROTOBUF_EXCLUDE = "exclude group: 'com.google.protobuf', module: 'protobuf-javalite'"

function withCrustProjectGradle(config: Parameters<ConfigPlugin>[0], navigation: boolean) {
  return withProjectBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents

    // Mapbox Downloads repo — ONLY when navigation is compiled in. A
    // non-navigating host never resolves the Nav SDK, so it must not need the
    // credential the repo authenticates.
    if (navigation && !gradle.includes(MAPBOX_REPO_MARKER)) {
      const reposMatch = gradle.match(/allprojects\s*\{[\s\S]*?repositories\s*\{/)
      if (reposMatch) {
        const idx = (reposMatch.index ?? 0) + reposMatch[0].length
        gradle = gradle.slice(0, idx) + "\n" + MAPBOX_REPO + gradle.slice(idx)
      } else {
        gradle += `\nallprojects {\n  repositories {\n${MAPBOX_REPO}\n  }\n}\n`
      }
    }

    // protobuf-javalite exclusion, appended as its own allprojects block so
    // placement never depends on the shape of existing gradle content (other
    // plugins add maven{} entries that break brace-counting regexes).
    if (!gradle.includes(PROTOBUF_EXCLUDE)) {
      gradle += `
// Exclude protobuf-javalite in every project to avoid duplicate classes with
// protobuf-java (injected by @mentra/crust).
allprojects {
  configurations.all {
    ${PROTOBUF_EXCLUDE}
  }
}
`
    }

    cfg.modResults.contents = gradle
    return cfg
  })
}

function withCrustAppGradle(config: Parameters<ConfigPlugin>[0]) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents

    if (!gradle.includes("coreLibraryDesugaringEnabled")) {
      gradle = gradle.replace(
        /(namespace\s+['"][^'"]+['"])/,
        `$1
    compileOptions {
        coreLibraryDesugaringEnabled true
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }`,
      )
    }

    if (!gradle.includes("coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs")) {
      gradle = gradle.replace(
        /(implementation\("com\.facebook\.react:react-android"\))/,
        `$1

    // Required by :mentra-crust (Mapbox Navigation SDK uses newer core libs).
    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.4'`,
      )
    }

    cfg.modResults.contents = gradle
    return cfg
  })
}

// crust's android/build.gradle reads this property to switch the Nav SDK
// dependency between `implementation` (in the APK) and `compileOnly`.
function withCrustNavigationProperty(config: Parameters<ConfigPlugin>[0], navigation: boolean) {
  return withGradleProperties(config, (cfg) => {
    const key = "mentraCrustNavigation"
    cfg.modResults = cfg.modResults.filter((item) => !(item.type === "property" && item.key === key))
    cfg.modResults.push({type: "property", key, value: String(navigation)})
    return cfg
  })
}

export const withCrustAndroidBuildContract = (
  config: ExportedConfig,
  {navigation}: CrustAndroidOptions,
): ExportedConfig => {
  config = withCrustNavigationProperty(config, navigation)
  config = withCrustProjectGradle(config, navigation)
  return withCrustAppGradle(config)
}
