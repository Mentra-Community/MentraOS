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

// Get connected iOS devices via devicectl
const tmpFile = `/tmp/devicectl-${Date.now()}.json`
await $`xcrun devicectl list devices --json-output ${tmpFile} --timeout 5`
const json = JSON.parse(await fs.readFile(tmpFile, "utf-8"))
await fs.remove(tmpFile)

const device =
  json.result?.devices?.find(
    (d) => d.capabilities?.some((c) => c.name === "iPhone") || d.deviceProperties?.marketingName?.includes("iPhone"),
  ) &&
  json.result.devices.find(
    (d) =>
      (d.capabilities?.some((c) => c.name === "iPhone") || d.deviceProperties?.marketingName?.includes("iPhone")) &&
      d.connectionProperties?.tunnelState === "connected",
  )

if (!device) {
  // Fallback: find any available paired iPhone
  const available = json.result?.devices?.find(
    (d) =>
      d.hardwareProperties?.deviceType === "iPhone" &&
      d.connectionProperties?.pairingState === "paired" &&
      d.connectionProperties?.tunnelState !== "unavailable",
  )
  if (!available) {
    console.log("No physical iPhone connected — building release for iOS Simulator")
    await $({stdio: "inherit"})`bun expo run:ios --configuration Release --no-bundler`
    console.log("✅ iOS release built and installed on Simulator!")
    process.exit(0)
  }
  var deviceName = available.deviceProperties.name
} else {
  var deviceName = device.deviceProperties.name
}

console.log(`Using device: ${deviceName}`)

// Build and install release on device
await $({stdio: "inherit"})`bun expo run:ios --device ${deviceName} --configuration Release --no-bundler`

console.log("✅ iOS release built and installed successfully!")
