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

let selectedDevice = device
if (!device) {
  // Fallback: find any available paired iPhone
  selectedDevice = json.result?.devices?.find(
    (d) =>
      d.hardwareProperties?.deviceType === "iPhone" &&
      d.connectionProperties?.pairingState === "paired" &&
      d.connectionProperties?.tunnelState !== "unavailable",
  )
  if (!selectedDevice) {
    console.error("No physical iPhone found")
    process.exit(1)
  }
}

const deviceName = selectedDevice.deviceProperties.name
const deviceIdentifier = selectedDevice.identifier

console.log(`Using device: ${deviceName}`)

// Start device log streaming in background - filter for app bundle ID
console.log("Starting device log stream (filtering for com.mentra.okbeanie)...")
const logProcess = $({
  stdio: "pipe",
})`xcrun devicectl device log stream --device ${deviceIdentifier} --style compact`.pipe(
  $({stdio: "inherit"})`grep -E "(com\\.mentra\\.okbeanie|mentra|MENTRA|MentraOS|Bridge\\.log)" || true`,
)
logProcess.catch(() => {}) // Ignore errors from log stream

await $({stdio: "inherit"})`bun expo run:ios --device ${deviceName}`
