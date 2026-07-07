const {withProjectBuildGradle} = require("expo/config-plugins")

// @mentra/crust (autolinked from mobile/modules) depends on
// com.mapbox.navigationcore:*, which lives only in Mapbox's private Downloads
// registry. The Mentra app injects this authenticated repo with its own local
// config plugin (mobile/plugins/android.ts); a standalone host must do the
// same — this is that plugin for the example OEM app. The token is read at
// GRADLE time from MAPBOX_DOWNLOADS_TOKEN (CI secret / env) with a
// gradle-property fallback for manual setups; prebuild only writes the block.
const MAPBOX_REPO = [
  "    maven {",
  "      // mapbox: navigation sdk downloads repo (injected by withMapboxDownloadsRepo)",
  "      url 'https://api.mapbox.com/downloads/v2/releases/maven'",
  "      authentication { basic(BasicAuthentication) }",
  "      credentials {",
  "        username = 'mapbox'",
  "        password = System.getenv('MAPBOX_DOWNLOADS_TOKEN') ?: (findProperty('MAPBOX_DOWNLOADS_TOKEN') ?: '')",
  "      }",
  "    }",
].join("\n")

module.exports = function withMapboxDownloadsRepo(config) {
  return withProjectBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents
    if (!gradle.includes("api.mapbox.com/downloads")) {
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
