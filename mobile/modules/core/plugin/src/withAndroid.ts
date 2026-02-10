import {execSync} from "child_process"
import path from "path"

import {type ConfigPlugin, withSettingsGradle, withGradleProperties} from "expo/config-plugins"

/**
 * Modify settings.gradle to include lc3Lib module
 */
function withSettingsGradleModifications(config: any) {
  return withSettingsGradle(config, config => {
    let settingsGradle = config.modResults.contents

    // Add lc3Lib module if not present
    if (!settingsGradle.includes("include ':lc3Lib'")) {
      settingsGradle += `
  include ':lc3Lib'
  project(':lc3Lib').projectDir = new File(rootDir, '../modules/core/android/lc3Lib')
  `
    }

    config.modResults.contents = settingsGradle
    return config
  })
}

/**
 * Modify gradle.properties to add Sentry configuration and node path
 */
function withGradlePropertiesModifications(config: any) {
  return withGradleProperties(config, config => {
    let props = config.modResults

    // Get node path and add to org.gradle.jvmargs
    try {
      const nodeExecutable = execSync("which node", {encoding: "utf-8"}).trim()
      // Get parent directory of bin (e.g., /path/to/node/bin/node -> /path/to/node)
      const nodePath = path.dirname(nodeExecutable)

      // Find existing org.gradle.jvmargs property
      const jvmArgsIndex = props.findIndex(p => p.type === "property" && p.key === "org.gradle.jvmargs")

      if (jvmArgsIndex !== -1) {
        // Append nodePath to existing jvmargs if not already present
        const jvmArgsProp = props[jvmArgsIndex]
        if (jvmArgsProp.type === "property" && "value" in jvmArgsProp) {
          const currentValue = jvmArgsProp.value
          if (!currentValue.includes("-Dorg.gradle.project.nodePath=")) {
            jvmArgsProp.value = `${currentValue} -Dorg.gradle.project.nodePath=${nodePath}`
          }
        }
      } else {
        // Create new jvmargs property with nodePath
        props.push({
          type: "property",
          key: "org.gradle.jvmargs",
          value: `-Dorg.gradle.project.nodePath=${nodePath}`,
        })
      }
    } catch (error) {
      console.warn("Failed to get node path:", error)
    }

    config.modResults = props
    return config
  })
}

export const withAndroidConfiguration: ConfigPlugin<{node?: boolean}> = (config, props) => {
  config = withSettingsGradleModifications(config)

  if (props?.node) {
    config = withGradlePropertiesModifications(config)
  }

  return config
}
