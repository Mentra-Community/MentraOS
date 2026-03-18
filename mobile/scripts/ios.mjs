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
    console.error("No physical iPhone found")
    process.exit(1)
  }
  var deviceName = available.deviceProperties.name
} else {
  var deviceName = device.deviceProperties.name
}

console.log(`Using device: ${deviceName}`)
await $({stdio: "inherit"})`bun expo run:ios --device ${deviceName}`
