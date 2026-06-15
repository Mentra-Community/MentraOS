import {execSync} from "child_process"
import path from "path"

import {
  AndroidConfig,
  type ConfigPlugin,
  withAndroidManifest,
  withGradleProperties,
  withProjectBuildGradle,
  withSettingsGradle,
} from "expo/config-plugins"

import {type BluetoothSdkPluginProps} from "./index"

const META_ANALYTICS_DISABLED = "com.mentra.bluetoothsdk.analytics.disabled"
const STALE_META_POSTHOG_API_KEY = "com.mentra.bluetoothsdk.analytics.posthog_api_key"
const STALE_META_POSTHOG_HOST = "com.mentra.bluetoothsdk.analytics.posthog_host"
const ANALYTICS_META_NAMES = [META_ANALYTICS_DISABLED, STALE_META_POSTHOG_API_KEY, STALE_META_POSTHOG_HOST]

function getBluetoothSdkRoot(): string {
  return path.dirname(require.resolve("../../package.json"))
}

function toGroovyString(value: string): string {
  return JSON.stringify(value)
}

/**
 * Modify settings.gradle to include lc3Lib and silero modules
 */
function withSettingsGradleModifications(config: any) {
  return withSettingsGradle(config, (config) => {
    let settingsGradle = config.modResults.contents
    const bluetoothSdkRoot = getBluetoothSdkRoot()
    const bluetoothSdkRootExpression = `System.getenv("MENTRA_BLUETOOTH_SDK_PACKAGE_PATH") ?: ${toGroovyString(bluetoothSdkRoot)}`

    if (!settingsGradle.includes("project(':mentra-bluetooth-sdk').projectDir")) {
      const bluetoothSdkProjectBlock = `
  if (findProject(':mentra-bluetooth-sdk') != null) {
    project(':mentra-bluetooth-sdk').projectDir = new File(${bluetoothSdkRootExpression}, 'android')
  }
`
      const lc3Include = "  include ':lc3Lib'"
      settingsGradle = settingsGradle.includes(lc3Include)
        ? settingsGradle.replace(lc3Include, `${bluetoothSdkProjectBlock}\n${lc3Include}`)
        : `${settingsGradle}${bluetoothSdkProjectBlock}`
    }

    if (!settingsGradle.includes("include ':lc3Lib'")) {
      settingsGradle += `
  include ':lc3Lib'
  `
    }

    if (!settingsGradle.includes("project(':lc3Lib').projectDir")) {
      settingsGradle += `
  project(':lc3Lib').projectDir = new File(${bluetoothSdkRootExpression}, 'android/lc3Lib')
  `
    }

    if (!settingsGradle.includes("include ':silero'")) {
      settingsGradle += `
  include ':silero'
  `
    }

    if (!settingsGradle.includes("project(':silero').projectDir")) {
      settingsGradle += `
  project(':silero').projectDir = new File(${bluetoothSdkRootExpression}, 'android/silero')
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
    const fallbackRoot = toGroovyString(getBluetoothSdkRoot())
    const repoDirExpression = `new File(System.getenv("MENTRA_BLUETOOTH_SDK_PACKAGE_PATH") ?: ${fallbackRoot}, "android/libs/maven")`
    const marker = "// bluetooth-sdk: sherpa-onnx local maven repo"

    if (contents.includes(marker)) {
      return config
    }

    const repoBlock = `    maven {\n      ${marker}\n      url = uri(${repoDirExpression})\n    }`

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

function resolveAnalyticsProps(props: BluetoothSdkPluginProps | undefined) {
  const analytics = props?.analytics
  let disabled: boolean | undefined
  if (analytics === false) {
    disabled = true
  } else if (analytics === true) {
    disabled = false
  } else if (typeof analytics === "object" && analytics.enabled !== undefined) {
    disabled = !analytics.enabled
  }

  return {
    disabled,
  }
}

function upsertMetaData(application: any, name: string, value: string) {
  application["meta-data"] ??= []
  const existing = application["meta-data"].find((item: any) => item.$?.["android:name"] === name)
  const entry = existing ?? {$: {"android:name": name}}
  entry.$["android:value"] = value

  if (!existing) {
    application["meta-data"].push(entry)
  }
}

function removeMetaData(application: any, name: string) {
  application["meta-data"] = (application["meta-data"] ?? []).filter((item: any) => item.$?.["android:name"] !== name)
}

function withAnalyticsManifestMetadata(config: any, props: BluetoothSdkPluginProps | undefined) {
  return withAndroidManifest(config, (config) => {
    const analytics = resolveAnalyticsProps(props)
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults)

    for (const name of ANALYTICS_META_NAMES) {
      removeMetaData(application, name)
    }

    if (analytics.disabled !== undefined) {
      upsertMetaData(application, META_ANALYTICS_DISABLED, analytics.disabled ? "true" : "false")
    }

    return config
  })
}

export const withAndroidConfiguration: ConfigPlugin<BluetoothSdkPluginProps> = (config, props) => {
  config = withSettingsGradleModifications(config)
  config = withSherpaOnnxLocalMavenRepo(config)
  config = withAnalyticsManifestMetadata(config, props)

  if (props?.node) {
    config = withGradlePropertiesModifications(config)
  }

  return config
}
