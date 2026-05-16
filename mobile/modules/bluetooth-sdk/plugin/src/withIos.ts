import {execSync} from "child_process"
import fs from "fs"
import path from "path"

import {type ConfigPlugin, withDangerousMod, withPodfile} from "expo/config-plugins"

const BLUETOOTH_SDK_EXPO_ADAPTER_ENV = "MENTRA_BLUETOOTH_SDK_INCLUDE_EXPO_ADAPTER"
const BLUETOOTH_SDK_EXPO_ADAPTER_LINE = `ENV['${BLUETOOTH_SDK_EXPO_ADAPTER_ENV}'] ||= '1'`

const ensureBluetoothSdkExpoAdapterPodEnv = (podfile: string): string => {
  if (podfile.includes(BLUETOOTH_SDK_EXPO_ADAPTER_ENV)) {
    return podfile
  }

  const insertion = [
    "  # Expo apps need the SDK's Expo module adapter so autolinking can register CoreModule.",
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

export const withIosConfiguration: ConfigPlugin<{node?: boolean}> = (config, props) => {
  config = withPodfile(config, (config) => {
    config.modResults.contents = ensureBluetoothSdkExpoAdapterPodEnv(config.modResults.contents)
    return config
  })

  if (props?.node) {
    config = withXcodeEnvLocal(config)
  }
  return config
}
