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
await $({stdio: "inherit"})`bun expo run:ios --device ${deviceUdid}`
