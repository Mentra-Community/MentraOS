const {withAppBuildGradle, withProjectBuildGradle} = require("expo/config-plugins")

// @mentra/crust (autolinked from mobile/modules) depends on
// com.mapbox.navigationcore:*, which lives only in Mapbox's private Downloads
// registry. The Mentra app injects this authenticated repo with its own local
// config plugin (mobile/plugins/android.ts); a standalone host must do the
// same — this is that plugin for the example OEM app. The token is read at
// GRADLE time from MAPBOX_DOWNLOADS_TOKEN (CI secret / env) with a
// gradle-property fallback for manual setups; prebuild only writes the block.
const MAPBOX_REPO = [
  "    maven {",
  "      // mapbox: navigation sdk downloads repo (injected by withMentraStackGradle)",
  "      url 'https://api.mapbox.com/downloads/v2/releases/maven'",
  "      authentication { basic(BasicAuthentication) }",
  "      credentials {",
  "        username = 'mapbox'",
  "        password = System.getenv('MAPBOX_DOWNLOADS_TOKEN') ?: (findProperty('MAPBOX_DOWNLOADS_TOKEN') ?: '')",
  "      }",
  "    }",
].join("\n")

function withMentraProjectGradle(config) {
  return withProjectBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents

    // Global protobuf-javalite exclusion: the bluetooth-sdk/crust native stack
    // needs protobuf-java, and Mapbox transitively drags protobuf-javalite —
    // shipping both fails the release build with duplicate classes. Appended
    // as its own allprojects block at the end of the file so placement never
    // depends on the shape of existing gradle content (other plugins add
    // maven{} entries that break brace-counting regexes).
    if (!gradle.includes("exclude group: 'com.google.protobuf', module: 'protobuf-javalite'")) {
      gradle += `
// Exclude protobuf-javalite in every project to avoid duplicate classes with
// protobuf-java (injected by withMentraStackGradle).
allprojects {
  configurations.all {
    exclude group: 'com.google.protobuf', module: 'protobuf-javalite'
  }
}
`
    }

    if (!gradle.includes("mapbox: navigation sdk downloads repo (injected by withMentraStackGradle)")) {
      const reposMatch = gradle.match(/allprojects\s*\{[\s\S]*?repositories\s*\{/)
      if (reposMatch) {
        const idx = (reposMatch.index ?? 0) + reposMatch[0].length
        gradle = gradle.slice(0, idx) + "\n" + MAPBOX_REPO + gradle.slice(idx)
      } else {
        gradle += `\nallprojects {\n  repositories {\n${MAPBOX_REPO}\n  }\n}\n`
      }
    }
    cfg.modResults.contents = gradle
    return cfg
  })
}

// App-level gradle requirements of the Mentra stack, mirrored from the Mentra
// app's plugin: crust (via the Mapbox Nav SDK) requires core-library
// desugaring on any app that embeds it.
function withCrustDesugaring(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents
    if (!gradle.includes("coreLibraryDesugaringEnabled")) {
      gradle = gradle.replace(
        /(namespace\s+['"]com\.mentra\.exampleoemapp['"])/,
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

module.exports = function withMentraStackGradle(config) {
  config = withMentraProjectGradle(config)
  return withCrustDesugaring(config)
}
