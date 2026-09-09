import {execFileSync} from "node:child_process"
import {createRequire} from "node:module"

const require = createRequire(import.meta.url)

// Keys the @mentra/bluetooth-sdk config plugin stamps into Info.plist.
export const INFO_SDK_VERSION = "MentraBluetoothSdkVersion"
export const INFO_ANALYTICS_ENVIRONMENT = "MentraBluetoothSdkAnalyticsEnvironment"
export const INFO_ANALYTICS_DISABLED = "MentraBluetoothSdkAnalyticsDisabled"

/**
 * What a Mentra App release archive must carry for the Bluetooth SDK's usage
 * analytics to be attributable: the SDK version (the shipped 3.1 iOS build
 * reported none) and the build lane the app was built for. The SDK still sends
 * events without them, so this is a release gate, not a runtime failure.
 */
export function expectedSdkAnalyticsMetadata(env = process.env) {
  const sdkVersion = require("../modules/bluetooth-sdk/package.json").version
  const environment = env.EXPO_PUBLIC_BUILD_ENV?.trim().toLowerCase() || undefined
  return {sdkVersion, environment}
}

export function assertSdkAnalyticsMetadata(infoPlist, expected, platform = "iOS") {
  const problems = []
  if (infoPlist[INFO_SDK_VERSION] !== expected.sdkVersion) {
    problems.push(
      `${INFO_SDK_VERSION}=${JSON.stringify(infoPlist[INFO_SDK_VERSION] ?? null)} (expected ${expected.sdkVersion})`,
    )
  }
  if (expected.environment && infoPlist[INFO_ANALYTICS_ENVIRONMENT] !== expected.environment) {
    problems.push(
      `${INFO_ANALYTICS_ENVIRONMENT}=${JSON.stringify(infoPlist[INFO_ANALYTICS_ENVIRONMENT] ?? null)} (expected ${
        expected.environment
      })`,
    )
  }
  if (infoPlist[INFO_ANALYTICS_DISABLED] === true) {
    problems.push(
      `${INFO_ANALYTICS_DISABLED}=true (Bluetooth SDK analytics must ship enabled; they are the glasses WAU source)`,
    )
  }
  if (problems.length > 0) {
    throw new Error(`${platform} release Info.plist has wrong Bluetooth SDK analytics metadata: ${problems.join("; ")}`)
  }
}

export function readIpaInfoPlist(ipaPath) {
  const plist = execFileSync("unzip", ["-p", ipaPath, "Payload/*.app/Info.plist"], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const json = execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {input: plist, encoding: "utf8"})
  return JSON.parse(json)
}

export function validateIosSdkAnalyticsMetadata(ipaPath, env = process.env) {
  assertSdkAnalyticsMetadata(readIpaInfoPlist(ipaPath), expectedSdkAnalyticsMetadata(env), "iOS")
}
