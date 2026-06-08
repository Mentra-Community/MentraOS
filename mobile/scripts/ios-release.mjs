#!/usr/bin/env zx
import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

console.log("Building iOS release...")

// prebuild ios:
await $({stdio: "inherit"})`bun expo prebuild --platform ios`

// copy .env to ios/.xcode.env.local:
await $({stdio: "inherit"})`cp .env ios/.xcode.env.local`

// Sync CocoaPods after prebuild so new native source files are compiled
await $({stdio: "inherit", cwd: "ios"})`pod install`

function isConnectedIphone(device) {
  return (
    (device.capabilities?.some((c) => c.name === "iPhone") ||
      device.deviceProperties?.marketingName?.includes("iPhone")) &&
    device.connectionProperties?.tunnelState === "connected"
  )
}

async function listDevicesViaDevicectl() {
  const tmpFile = `/tmp/devicectl-${Date.now()}.json`
  try {
    await $`xcrun devicectl list devices --json-output ${tmpFile} --timeout 5`
    const json = JSON.parse(await fs.readFile(tmpFile, "utf-8"))
    return json.result?.devices ?? []
  } catch (error) {
    console.warn("devicectl probe failed, falling back to simulator:", error?.message ?? error)
    return null
  } finally {
    await fs.remove(tmpFile).catch(() => {})
  }
}

const devices = await listDevicesViaDevicectl()

let deviceName
if (devices) {
  const device = devices.find(isConnectedIphone)
  if (device) {
    deviceName = device.deviceProperties.name
  }
}

if (!deviceName) {
  console.log("No physical iPhone connected — building release for iOS Simulator")
  await $({stdio: "inherit"})`bun expo run:ios --configuration Release --no-bundler`
  console.log("✅ iOS release built and installed on Simulator!")
  process.exit(0)
}

console.log(`Using device: ${deviceName}`)

// Build and install release on device
await $({stdio: "inherit"})`bun expo run:ios --device ${deviceName} --configuration Release --no-bundler`

console.log("✅ iOS release built and installed successfully!")
