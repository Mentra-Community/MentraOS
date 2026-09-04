#!/usr/bin/env zx
import {runPodInstall} from "./cocoapods-install.mjs"
import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

// prebuild ios:
await $({stdio: "inherit"})`bun expo prebuild --platform ios`

// Sync CocoaPods after prebuild so local podspec/native config changes are
// reflected before xcodebuild compiles the generated workspace. Prefetch
// Folly/boost/etc. as GitHub tarballs so `git clone` timeouts don't abort.
await runPodInstall({cwd: "ios"})

// copy .env to ios/.xcode.env.local:
await $({stdio: "inherit"})`cp .env ios/.xcode.env.local`

// Get connected iOS devices via devicectl
const listDevices = async () => {
  const tmpFile = `/tmp/devicectl-${Date.now()}.json`
  await $`xcrun devicectl list devices --json-output ${tmpFile} --timeout 5`
  const json = JSON.parse(await fs.readFile(tmpFile, "utf-8"))
  await fs.remove(tmpFile)
  return json.result?.devices ?? []
}

const isSupportedIosDevice = (d) =>
  d.hardwareProperties?.platform === "iOS" ||
  ["iPhone", "iPad"].includes(d.hardwareProperties?.deviceType) ||
  d.capabilities?.some((c) => ["iPhone", "iPad"].includes(c.name)) ||
  /iPhone|iPad/.test(d.deviceProperties?.marketingName ?? "")

let pairedDevices = (await listDevices()).filter(
  (d) =>
    isSupportedIosDevice(d) &&
    d.connectionProperties?.pairingState === "paired" &&
    d.connectionProperties?.tunnelState !== "unavailable",
)

let connected = pairedDevices.find((d) => d.connectionProperties?.tunnelState === "connected")

// A newly plugged/unlocked iOS device can show as paired+wired but
// tunnelState=disconnected until a CoreDevice command touches it. Warm the
// tunnel once before failing, then re-read the list the build path uses.
if (!connected && pairedDevices.length > 0) {
  const candidate = pairedDevices.find((d) => d.connectionProperties?.transportType === "wired") ?? pairedDevices[0]
  const candidateId = candidate.hardwareProperties?.udid ?? candidate.identifier
  if (candidateId) {
    console.log(`Warming iOS device tunnel for ${candidate.deviceProperties.name} (${candidateId})...`)
    try {
      await $`xcrun devicectl device info details --device ${candidateId} --timeout 15`
    } catch (error) {
      console.warn(`Could not warm iOS device tunnel: ${error}`)
    }
    pairedDevices = (await listDevices()).filter(
      (d) =>
        isSupportedIosDevice(d) &&
        d.connectionProperties?.pairingState === "paired" &&
        d.connectionProperties?.tunnelState !== "unavailable",
    )
    connected = pairedDevices.find((d) => d.connectionProperties?.tunnelState === "connected")
  }
}

if (!connected) {
  if (pairedDevices.length > 0) {
    const offline = pairedDevices[0]
    console.error(
      `iOS device "${offline.deviceProperties.name}" is paired but not connected (tunnel: ${offline.connectionProperties.tunnelState}).`,
    )
    console.error("Plug in via USB, unlock the device, tap Trust on the device, then retry.")
    process.exit(1)
  }
  console.error("No physical iPhone or iPad found")
  process.exit(1)
}

const deviceUdid = connected.hardwareProperties.udid
const deviceName = connected.deviceProperties.name

console.log(`Using device: ${deviceName} (${deviceUdid})`)

// `bun expo run:ios` builds fine but its bundled @expo/cli uses a home-grown
// JS lockdownd client to install on-device, which throws
// "TypeError: Cannot convert object to primitive value" against current iOS.
// So we drive the build with xcodebuild and install/launch with Apple's
// `devicectl` — the same tool the device-detection above already relies on.
// The workspace/scheme follow the app name from app.config.ts (variant
// dependent — "MentraOS" on this branch), so derive them from what prebuild
// actually generated instead of hardcoding a name that goes stale on rename.
const workspaces = await glob("ios/*.xcworkspace", {onlyDirectories: true})
if (workspaces.length !== 1) {
  throw new Error(`Expected exactly one ios/*.xcworkspace after prebuild, found: ${workspaces.join(", ") || "none"}`)
}
const WORKSPACE = workspaces[0]
const SCHEME = path.basename(WORKSPACE, ".xcworkspace")
const BUNDLE_ID = "com.mentra.mentra"
const derivedData = "ios/build"

// Automatic signing cannot mint a cert when the keychain only has expired
// Apple Development identities (Xcode then dies with "No Accounts" / missing
// "iOS Development" cert and a wall of unrelated Pods deployment-target
// warnings). Fail before the 10-minute compile.
const signingProbe = await $({nothrow: true})`security find-identity -p codesigning`
const signingText = `${signingProbe.stdout}${signingProbe.stderr}`
const validCount = Number(/(\d+) valid identities found/.exec(signingText)?.[1] ?? 0)
if (validCount === 0) {
  const expired = [...new Set([...signingText.matchAll(/"([^"]+)" \(CSSMERR_TP_CERT_EXPIRED\)/g)].map((m) => m[1]))]
  console.error("iOS code signing failed: no valid Apple Development identity in the keychain.")
  if (expired.length > 0) {
    console.error("Expired identities:")
    for (const name of expired) {
      console.error(`  - ${name}`)
    }
  }
  console.error("The Mentra team cert (T5XXXL6N36) must be renewed before a device Debug build can sign.")
  console.error("Open Xcode → Settings → Accounts, sign in, select Mentra Labs, then Manage Certificates → + Apple Development.")
  process.exit(1)
}

// Build for the connected device.
await $({stdio: "inherit"})`xcodebuild \
  -workspace ${WORKSPACE} \
  -scheme ${SCHEME} \
  -configuration Debug \
  -destination id=${deviceUdid} \
  -derivedDataPath ${derivedData} \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  build`

// The bundle is named after PRODUCT_NAME ("Mentra"), not the scheme/project
// ("MentraOS" on this branch) — glob the products dir instead of assuming.
const appBundles = await glob(`${derivedData}/Build/Products/Debug-iphoneos/*.app`, {onlyDirectories: true})
if (appBundles.length === 0) {
  throw new Error(`Expected a built .app bundle under ${derivedData}/Build/Products/Debug-iphoneos, found none`)
}
// ios/build persists between runs, so a renamed target/product can leave stale
// bundles behind — install the one the build we just ran produced (newest mtime).
let appPath = appBundles[0]
if (appBundles.length > 1) {
  const byMtime = await Promise.all(appBundles.map(async (p) => ({p, mtimeMs: (await fs.stat(p)).mtimeMs})))
  byMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)
  appPath = byMtime[0].p
  console.log(`Multiple .app bundles found (${appBundles.join(", ")}); installing newest: ${appPath}`)
}

// Install + launch via devicectl (works where expo's installer fails).
await $({stdio: "inherit"})`xcrun devicectl device install app --device ${deviceUdid} ${appPath}`
await $({stdio: "inherit"})`xcrun devicectl device process launch --device ${deviceUdid} ${BUNDLE_ID}`

// Start Metro in its own clean process so the dev client can connect.
await $({stdio: "inherit"})`bun expo start --dev-client`

// // Build & install the app without starting the bundler. `expo run:ios` does
// // not exit on its own after install (it stays attached to the device, showing
// // a "Connecting to <device>" spinner that pollutes the logs), so we stream its
// // output, kill it once the app is installed, then start Metro in a clean
// // process of our own.
// const runProc = $`bun expo run:ios --device ${deviceUdid} --no-bundler`

// let installed = false
// for await (const chunk of runProc.stdout) {
//   process.stdout.write(chunk)
//   if (/Installing .*\.app/.test(chunk.toString())) {
//     installed = true
//     // Give the install/launch a moment to finish, then stop the hung process.
//     await new Promise((r) => setTimeout(r, 6000))
//     runProc.kill("SIGINT")
//     break
//   }
// }

// try {
//   await runProc
// } catch {
//   // We SIGINT'd it on purpose; ignore the resulting non-zero exit.
// }

// if (!installed) {
//   console.error("Build/install did not complete; not starting Metro.")
//   process.exit(1)
// }

// // Start Metro separately in its own clean process.
// await $({stdio: "inherit"})`bun expo start --dev-client`
