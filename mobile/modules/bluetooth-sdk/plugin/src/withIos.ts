import {execSync} from "child_process"
import fs from "fs"
import path from "path"

import {type ConfigPlugin, withDangerousMod, withInfoPlist, withPodfile} from "expo/config-plugins"

import {type BluetoothSdkPluginProps} from "./index"

const BLUETOOTH_SDK_EXPO_ADAPTER_ENV = "MENTRA_BLUETOOTH_SDK_INCLUDE_EXPO_ADAPTER"
const BLUETOOTH_SDK_EXPO_ADAPTER_LINE = `ENV['${BLUETOOTH_SDK_EXPO_ADAPTER_ENV}'] ||= '1'`
const INFO_ANALYTICS_DISABLED = "MentraBluetoothSdkAnalyticsDisabled"
const INFO_POSTHOG_API_KEY = "MentraBluetoothSdkPostHogApiKey"
const INFO_POSTHOG_HOST = "MentraBluetoothSdkPostHogHost"

const ensureBluetoothSdkExpoAdapterPodEnv = (podfile: string): string => {
  if (podfile.includes(BLUETOOTH_SDK_EXPO_ADAPTER_ENV)) {
    return podfile
  }

  const insertion = [
    "  # Expo apps need the SDK's Expo module adapter so autolinking can register BluetoothSdk.",
    `  ${BLUETOOTH_SDK_EXPO_ADAPTER_LINE}`,
    "",
  ].join("\n")

  return podfile.replace(/(target\s+['"][^'"]+['"]\s+do\n)/, `$1${insertion}`)
}

const withXcodeEnvLocal: ConfigPlugin = (config) => {
  return withDangerousMod(config, [
    "ios",
    async (config) => {
      try {
        // Get node executable path
        const nodeExecutable = execSync("which node", {encoding: "utf-8"}).trim()

        // Path to .xcode.env.local
        const iosPath = path.join(config.modRequest.platformProjectRoot)
        const xcodeEnvLocalPath = path.join(iosPath, ".xcode.env.local")

        // Content to write
        const content = `export NODE_BINARY=${nodeExecutable}\n`

        // Write or append to .xcode.env.local
        if (fs.existsSync(xcodeEnvLocalPath)) {
          const existingContent = fs.readFileSync(xcodeEnvLocalPath, "utf-8")
          if (!existingContent.includes("NODE_BINARY")) {
            fs.appendFileSync(xcodeEnvLocalPath, content)
          }
        } else {
          fs.writeFileSync(xcodeEnvLocalPath, content)
        }
      } catch (error) {
        console.warn("Failed to create .xcode.env.local:", error)
      }

      return config
    },
  ])
}

function resolveAnalyticsProps(props: BluetoothSdkPluginProps | undefined) {
  const analytics = props?.analytics
  const disabled =
    analytics === false ||
    (typeof analytics === "object" && analytics.enabled !== undefined ? !analytics.enabled : undefined)

  return {
    disabled,
    postHogApiKey: typeof analytics === "object" ? analytics.postHogApiKey : undefined,
    postHogHost: typeof analytics === "object" ? analytics.postHogHost : undefined,
  }
}

function withAnalyticsInfoPlist(config: any, props: BluetoothSdkPluginProps | undefined) {
  return withInfoPlist(config, (config) => {
    const analytics = resolveAnalyticsProps(props)

    delete config.modResults[INFO_ANALYTICS_DISABLED]
    delete config.modResults[INFO_POSTHOG_API_KEY]
    delete config.modResults[INFO_POSTHOG_HOST]

    if (analytics.disabled !== undefined) {
      config.modResults[INFO_ANALYTICS_DISABLED] = analytics.disabled
    }
    if (analytics.postHogApiKey) {
      config.modResults[INFO_POSTHOG_API_KEY] = analytics.postHogApiKey
    }
    if (analytics.postHogHost) {
      config.modResults[INFO_POSTHOG_HOST] = analytics.postHogHost
    }

    return config
  })
}

export const withIosConfiguration: ConfigPlugin<BluetoothSdkPluginProps> = (config, props) => {
  config = withPodfile(config, (config) => {
    config.modResults.contents = ensureBluetoothSdkExpoAdapterPodEnv(config.modResults.contents)
    return config
  })
  config = withAnalyticsInfoPlist(config, props)

  if (props?.node) {
    config = withXcodeEnvLocal(config)
  }
  return config
}
