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

// Build & install the app without starting the bundler. `expo run:ios` does
// not exit on its own after install (it stays attached to the device, showing
// a "Connecting to <device>" spinner that pollutes the logs), so we stream its
// output, kill it once the app is installed, then start Metro in a clean
// process of our own.
const runProc = $`bun expo run:ios --device ${deviceUdid} --no-bundler`

let installed = false
for await (const chunk of runProc.stdout) {
  process.stdout.write(chunk)
  if (/Installing .*\.app/.test(chunk.toString())) {
    installed = true
    // Give the install/launch a moment to finish, then stop the hung process.
    await new Promise((r) => setTimeout(r, 4000))
    runProc.kill("SIGINT")
    break
  }
}

try {
  await runProc
} catch {
  // We SIGINT'd it on purpose; ignore the resulting non-zero exit.
}

if (!installed) {
  console.error("Build/install did not complete; not starting Metro.")
  process.exit(1)
}

// Start Metro separately in its own clean process.
await $({stdio: "inherit"})`bun expo start --dev-client`
