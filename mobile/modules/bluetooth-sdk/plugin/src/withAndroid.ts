import {execSync} from "child_process"
import path from "path"

import {
  type ConfigPlugin,
  withGradleProperties,
  withProjectBuildGradle,
  withSettingsGradle,
} from "expo/config-plugins"

function getBluetoothSdkRoot(): string {
  return path.dirname(require.resolve("../../package.json"))
}

function toGroovyString(value: string): string {
  return JSON.stringify(value)
}

/**
 * Modify settings.gradle to include lc3Lib module
 */
function withSettingsGradleModifications(config: any) {
  return withSettingsGradle(config, (config) => {
    let settingsGradle = config.modResults.contents

    // Add lc3Lib module if not present
    if (!settingsGradle.includes("include ':lc3Lib'")) {
      const bluetoothSdkRoot = getBluetoothSdkRoot()
      settingsGradle += `
  include ':lc3Lib'
  project(':lc3Lib').projectDir = new File(${toGroovyString(bluetoothSdkRoot)}, 'android/lc3Lib')
  `
    }

    config.modResults.contents = settingsGradle
    return config
  })
}

/**
 * Modify gradle.properties to add node path for native builds launched outside a shell.
 */
function withGradlePropertiesModifications(config: any) {
  return withGradleProperties(config, (config) => {
    let props = config.modResults

    // Get node path and add to org.gradle.jvmargs
    try {
      const nodeExecutable = execSync("which node", {encoding: "utf-8"}).trim()
      // Get parent directory of bin (e.g., /path/to/node/bin/node -> /path/to/node)
      const nodePath = path.dirname(nodeExecutable)

      // Find existing org.gradle.jvmargs property
      const jvmArgsIndex = props.findIndex((p) => p.type === "property" && p.key === "org.gradle.jvmargs")

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

/**
 * Inject a local Maven repository into the root project's allprojects block so
 * that `:app` (and any other module that transitively pulls our deps) can
 * resolve `com.k2fsa.sherpa.onnx:sherpa-onnx`. The AAR is downloaded at
 * configure-time by bluetooth-sdk's own build.gradle into
 * `android/libs/maven/`; we just need that directory exposed as a maven repo
 * to consumers as well. AGP rejects raw local-.aar deps from library modules,
 * so the Maven layout is the supported workaround.
 */
function withSherpaOnnxLocalMavenRepo(config: any) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language !== "groovy") {
      return config
    }

    let contents = config.modResults.contents
    const repoDir = path.join(getBluetoothSdkRoot(), "android", "libs", "maven")
    const marker = "// bluetooth-sdk: sherpa-onnx local maven repo"

    if (contents.includes(marker)) {
      return config
    }

    const repoBlock = `    maven {\n      ${marker}\n      url = uri(${toGroovyString(repoDir)})\n    }`

    const allprojectsMatch = contents.match(/allprojects\s*\{[\s\S]*?repositories\s*\{/)
    if (allprojectsMatch) {
      const insertIdx = allprojectsMatch.index! + allprojectsMatch[0].length
      contents = contents.slice(0, insertIdx) + "\n" + repoBlock + contents.slice(insertIdx)
    } else {
      // Fallback: append an allprojects block. Older Expo templates that don't
      // emit allprojects {} put repositories in settings.gradle instead — but
      // this codebase's prebuild has historically emitted allprojects, so this
      // branch is just a safety net.
      contents += `\nallprojects {\n  repositories {\n${repoBlock}\n  }\n}\n`
    }

    config.modResults.contents = contents
    return config
  })
}

export const withAndroidConfiguration: ConfigPlugin<{node?: boolean}> = (config, props) => {
  config = withSettingsGradleModifications(config)
  config = withSherpaOnnxLocalMavenRepo(config)

  if (props?.node) {
    config = withGradlePropertiesModifications(config)
  }

  return config
}
