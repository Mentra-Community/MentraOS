import {withAppBuildGradle, withProjectBuildGradle, type ConfigPlugin} from "expo/config-plugins"

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

function withCrustProjectGradle(config: Parameters<ConfigPlugin>[0]) {
  return withProjectBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents

    // Mapbox Downloads repo, inserted at the top of allprojects.repositories.
    if (!gradle.includes(MAPBOX_REPO_MARKER)) {
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

export const withCrustAndroidBuildContract: ConfigPlugin = (config) => {
  config = withCrustProjectGradle(config)
  return withCrustAppGradle(config)
}
