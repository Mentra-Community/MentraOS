#!/usr/bin/env zx
import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

// prebuild ios:
await $({stdio: "inherit"})`bun expo prebuild --platform ios`

// copy .env to ios/.xcode.env.local:
await $({stdio: "inherit"})`cp .env ios/.xcode.env.local`

// Get connected iOS devices via devicectl
const tmpFile = `/tmp/devicectl-${Date.now()}.json`
await $`xcrun devicectl list devices --json-output ${tmpFile} --timeout 5`
const json = JSON.parse(await fs.readFile(tmpFile, "utf-8"))
await fs.remove(tmpFile)

const isIphone = (d) =>
  d.hardwareProperties?.deviceType === "iPhone" ||
  d.capabilities?.some((c) => c.name === "iPhone") ||
  d.deviceProperties?.marketingName?.includes("iPhone")

const pairedIphones = json.result?.devices?.filter(
  (d) =>
    isIphone(d) &&
    d.connectionProperties?.pairingState === "paired" &&
    d.connectionProperties?.tunnelState !== "unavailable",
) ?? []

const connected = pairedIphones.find(
  (d) => d.connectionProperties?.tunnelState === "connected",
)

if (!connected) {
  if (pairedIphones.length > 0) {
    const offline = pairedIphones[0]
    console.error(
      `iPhone "${offline.deviceProperties.name}" is paired but not connected (tunnel: ${offline.connectionProperties.tunnelState}).`,
    )
    console.error(
      "Plug in via USB, unlock the device, tap Trust on the device, then retry.",
    )
    process.exit(1)
  }
  console.error("No physical iPhone found")
  process.exit(1)
}

const deviceUdid = connected.hardwareProperties.udid
const deviceName = connected.deviceProperties.name

console.log(`Using device: ${deviceName} (${deviceUdid})`)

// NOTE: We deliberately do NOT use `expo run:ios` for the install/launch.
// Expo's bundled LockdowndClient crashes on newer iOS (26.x) with
// "TypeError: Cannot convert object to primitive value" during the device
// handshake. Instead we build with xcodebuild and install/launch with Apple's
// own `devicectl`, which works reliably. (Expo still owns prebuild above.)

const SCHEME = "Mentra"
const WORKSPACE = "ios/Mentra.xcworkspace"
const CONFIG = "Debug"
const BUNDLE_ID = "com.mentra.mentra"

// 1. Build for the connected device.
await $({
  stdio: "inherit",
})`xcodebuild -workspace ${WORKSPACE} -scheme ${SCHEME} -configuration ${CONFIG} -destination ${`id=${deviceUdid}`} -allowProvisioningUpdates build`

// 2. Resolve the built .app path from xcodebuild's settings (don't hardcode the
//    DerivedData hash).
const settingsJson = await $`xcodebuild -workspace ${WORKSPACE} -scheme ${SCHEME} -configuration ${CONFIG} -destination ${`id=${deviceUdid}`} -showBuildSettings -json`.quiet()
const settings = JSON.parse(settingsJson.stdout)
const build = settings.find((s) => s.buildSettings?.TARGET_BUILD_DIR && s.buildSettings?.FULL_PRODUCT_NAME)?.buildSettings
if (!build) {
  console.error("Could not resolve built .app path from xcodebuild settings")
  process.exit(1)
}
const appPath = `${build.TARGET_BUILD_DIR}/${build.FULL_PRODUCT_NAME}`
console.log(`Built app: ${appPath}`)

// 3. Install + launch via devicectl (bypasses Expo's broken LockdowndClient).
await $({stdio: "inherit"})`xcrun devicectl device install app --device ${deviceUdid} ${appPath}`
await $({
  stdio: "inherit",
})`xcrun devicectl device process launch --device ${deviceUdid} ${BUNDLE_ID}`

console.log("\n✅ Installed and launched on device.")
console.log("If the app shows a Metro error, start the dev server with: bun start")
