import {execFileSync} from "node:child_process"
import {existsSync, readdirSync} from "node:fs"
import {createRequire} from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)

// Keys the @mentra/bluetooth-sdk config plugin stamps into Info.plist.
export const INFO_SDK_VERSION = "MentraBluetoothSdkVersion"
export const INFO_ANALYTICS_ENVIRONMENT = "MentraBluetoothSdkAnalyticsEnvironment"
export const INFO_ANALYTICS_DISABLED = "MentraBluetoothSdkAnalyticsDisabled"
// Keys the same plugin stamps into AndroidManifest.xml.
export const META_ANALYTICS_ENVIRONMENT = "com.mentra.bluetoothsdk.analytics.environment"
export const META_ANALYTICS_DISABLED = "com.mentra.bluetoothsdk.analytics.disabled"

/**
 * What a Mentra App release archive must carry for the Bluetooth SDK's usage
 * analytics to be attributable: the SDK version (the shipped 3.1 iOS build
 * reported none) and the build lane the app was built for. The SDK still sends
 * events without them, so this is a release gate, not a runtime failure.
 */
export function expectedSdkAnalyticsMetadata(env = process.env) {
  const sdkVersion = require("../modules/bluetooth-sdk/package.json").version
  const environment = env.EXPO_PUBLIC_BUILD_ENV?.trim().toLowerCase()
  if (!environment) {
    throw new Error(
      "EXPO_PUBLIC_BUILD_ENV is not set; a Mentra App release must declare its lane (dev | staging | prod) so glasses analytics can separate store builds from the other lanes",
    )
  }
  return {sdkVersion, environment}
}

export function assertSdkAnalyticsMetadata(infoPlist, expected, platform = "iOS") {
  const problems = []
  if (infoPlist[INFO_SDK_VERSION] !== expected.sdkVersion) {
    problems.push(
      `${INFO_SDK_VERSION}=${JSON.stringify(infoPlist[INFO_SDK_VERSION] ?? null)} (expected ${expected.sdkVersion})`,
    )
  }
  if (infoPlist[INFO_ANALYTICS_ENVIRONMENT] !== expected.environment) {
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

// ---- Android -----------------------------------------------------------------

/** Parses `aapt2 dump xmltree` output into {metaDataName: value} for the application's meta-data entries. */
export function parseManifestMetaData(xmltree) {
  const meta = {}
  const lines = xmltree.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (!/E: meta-data/.test(lines[i])) continue
    let name
    let value
    for (let j = i + 1; j < lines.length && !/^\s*E: /.test(lines[j]); j++) {
      const m = lines[j].match(
        /android:(name|value)\([^)]*\)=(?:"([^"]*)"|\(type 0x12\)0x([0-9a-f]+)|\S+ \(Raw: "([^"]*)"\)|\S+)/,
      )
      if (!m) continue
      const raw = m[2] ?? m[4] ?? (m[3] !== undefined ? (m[3] === "0" ? "false" : "true") : undefined)
      if (m[1] === "name") name = raw
      else value = raw
    }
    if (name) meta[name] = value ?? ""
  }
  return meta
}

export function assertAndroidSdkAnalyticsMetadata(meta, expected, platform = "Android") {
  const problems = []
  if (String(meta[META_ANALYTICS_DISABLED]).toLowerCase() === "true") {
    problems.push(
      `${META_ANALYTICS_DISABLED}=true (Bluetooth SDK analytics must ship enabled; they are the glasses WAU source)`,
    )
  }
  if (meta[META_ANALYTICS_ENVIRONMENT] !== expected.environment) {
    problems.push(
      `${META_ANALYTICS_ENVIRONMENT}=${JSON.stringify(meta[META_ANALYTICS_ENVIRONMENT] ?? null)} (expected ${
        expected.environment
      })`,
    )
  }
  if (problems.length > 0) {
    throw new Error(`${platform} release manifest has wrong Bluetooth SDK analytics metadata: ${problems.join("; ")}`)
  }
}

export function findAapt2(env = process.env) {
  const home = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || path.join(env.HOME || "", "Library/Android/sdk")
  const buildTools = path.join(home, "build-tools")
  if (!existsSync(buildTools)) return null
  const versions = readdirSync(buildTools).sort((a, b) => a.localeCompare(b, undefined, {numeric: true}))
  for (const v of versions.reverse()) {
    const candidate = path.join(buildTools, v, "aapt2")
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function readApkManifestMetaData(apkPath, env = process.env) {
  const aapt2 = findAapt2(env)
  if (!aapt2)
    throw new Error("aapt2 not found under ANDROID_HOME/build-tools; cannot verify the Android release manifest")
  const xmltree = execFileSync(aapt2, ["dump", "xmltree", "--file", "AndroidManifest.xml", apkPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return parseManifestMetaData(xmltree)
}

export function validateAndroidSdkAnalyticsMetadata(apkPath, env = process.env) {
  assertAndroidSdkAnalyticsMetadata(readApkManifestMetaData(apkPath, env), expectedSdkAnalyticsMetadata(env), "Android")
}
