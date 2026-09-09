#!/usr/bin/env zx
import {runPodInstallIfNeeded} from "./cocoapods-install.mjs"
import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

// prebuild ios:
await $({stdio: "inherit"})`bun expo prebuild --platform ios`

// Sync CocoaPods after prebuild so local podspec/native config changes are
// reflected before xcodebuild compiles the generated workspace. Prefetch
// Folly/boost/etc. as GitHub tarballs so `git clone` timeouts don't abort.
// Skipped when nothing it depends on changed — see runPodInstallIfNeeded.
await runPodInstallIfNeeded({
  cwd: "ios",
  projectRoot: process.cwd(),
  force: process.env.MENTRA_POD_INSTALL === "force",
})

// copy .env to ios/.xcode.env.local:
await $({stdio: "inherit"})`cp .env ios/.xcode.env.local`

// Get connected iOS devices via devicectl
const listDevices = async () => {
  const tmpFile = `/tmp/devicectl-${Date.now()}.json`
  await $`xcrun devicectl list devices --json-output ${tmpFile} --timeout 10`
  const json = JSON.parse(await fs.readFile(tmpFile, "utf-8"))
  await fs.remove(tmpFile)
  return json.result?.devices ?? []
}

const isSupportedIosDevice = (d) =>
  d.hardwareProperties?.platform === "iOS" ||
  ["iPhone", "iPad"].includes(d.hardwareProperties?.deviceType) ||
  d.capabilities?.some((c) => ["iPhone", "iPad"].includes(c.name)) ||
  /iPhone|iPad/.test(d.deviceProperties?.marketingName ?? "")

const deviceId = (d) => d.hardwareProperties?.udid ?? d.identifier

const isPairedIos = (d) =>
  isSupportedIosDevice(d) && d.connectionProperties?.pairingState === "paired"

const isWired = (d) => {
  const transport = (d.connectionProperties?.transportType ?? "").toLowerCase()
  return transport === "wired" || transport === "usb"
}

const isTunnelConnected = (d) => d.connectionProperties?.tunnelState === "connected"

const describeDevice = (d) => {
  const name = d.deviceProperties?.name ?? "unknown"
  const tunnel = d.connectionProperties?.tunnelState ?? "unknown"
  const transport = d.connectionProperties?.transportType ?? "none"
  return `${name} tunnel=${tunnel} transport=${transport}`
}

const pickDevice = (devices) =>
  devices.find((d) => isTunnelConnected(d) && isWired(d)) ??
  devices.find((d) => isTunnelConnected(d)) ??
  devices.find((d) => isWired(d)) ??
  devices[0]

const listUsbUdids = async () => {
  const probe = await $({nothrow: true})`idevice_id -l`
  if (probe.exitCode !== 0) return []
  return `${probe.stdout}`
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^[0-9A-Fa-f-]{20,}$/.test(s))
}

const warmDevice = async (d) => {
  const id = deviceId(d)
  if (!id) return false
  console.log(`Warming iOS device tunnel for ${d.deviceProperties?.name ?? id} (${id})...`)
  console.log(`  ${describeDevice(d)}`)
  // Short timeout on purpose: a phone that is reachable answers in a couple of
  // seconds. Off-LAN it always fails, and the old 20s just stalled every run.
  const probe = await $({nothrow: true})`xcrun devicectl device info details --device ${id} --timeout 8`
  if (probe.exitCode !== 0) {
    console.warn(`Could not warm iOS device tunnel: ${probe.stderr || probe.stdout || probe.exitCode}`)
    return false
  }
  return true
}

let allDevices = await listDevices()
let pairedDevices = allDevices.filter(isPairedIos)
const usbUdids = await listUsbUdids()
if (usbUdids.length > 0) {
  console.log(`USB-attached iOS device(s): ${usbUdids.join(", ")}`)
}

// Prefer the phone actually on the cable. CoreDevice lists every historically
// paired iPhone as tunnel=unavailable when the Mac and phone are off-LAN, and
// picking the first one installs to a ghost ECID (error 1011).
const usbPaired = pairedDevices.filter((d) => usbUdids.includes(d.hardwareProperties?.udid))
let connected =
  usbPaired.find(isTunnelConnected) ??
  pairedDevices.find((d) => isTunnelConnected(d) && isWired(d)) ??
  pairedDevices.find(isTunnelConnected)

if (!connected && usbPaired.length > 0) {
  await Promise.all(usbPaired.map((candidate) => warmDevice(candidate)))
  allDevices = await listDevices()
  pairedDevices = allDevices.filter(isPairedIos)
  connected =
    pairedDevices.find((d) => usbUdids.includes(d.hardwareProperties?.udid) && isTunnelConnected(d)) ??
    pairedDevices.find(isTunnelConnected)
}

const target =
  connected ??
  pickDevice(usbPaired) ??
  (usbUdids[0] ? {hardwareProperties: {udid: usbUdids[0]}, deviceProperties: {name: "USB iPhone"}} : pickDevice(pairedDevices))
const deviceUdid = target ? (target.hardwareProperties?.udid ?? deviceId(target) ?? usbUdids[0]) : usbUdids[0]
const deviceName = target?.deviceProperties?.name ?? deviceUdid

if (!target || !deviceUdid) {
  const seen = allDevices.filter(isSupportedIosDevice)
  if (pairedDevices.length > 0) {
    console.error("Paired iOS devices, but none have a usable UDID:")
    for (const d of pairedDevices) console.error(`  - ${describeDevice(d)}`)
  } else {
    console.error("No physical iPhone or iPad found")
    if (seen.length > 0) {
      console.error("Seen iOS devices (not paired or not ready):")
      for (const d of seen) {
        console.error(`  - ${describeDevice(d)} pairing=${d.connectionProperties?.pairingState}`)
      }
    }
  }
  console.error("Plug in via USB, unlock the device, tap Trust on the device, then retry.")
  console.error("Same Wi-Fi is not required for USB install.")
  process.exit(1)
}

const useGenericDestination = !isTunnelConnected(target)
if (useGenericDestination) {
  console.warn(`Device tunnel is ${target.connectionProperties?.tunnelState} (${describeDevice(target)}).`)
  console.warn("Building for generic iOS and installing over USB. Same Wi-Fi is not required.")
}

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

// Build for the connected device. If CoreDevice has no live tunnel (common
// when the phone is on a different Wi-Fi), xcodebuild cannot resolve
// `-destination id=UDID` — compile for generic iOS, then install by UDID.
const destination = useGenericDestination ? "generic/platform=iOS" : `id=${deviceUdid}`
await $({stdio: "inherit"})`xcodebuild \
  -workspace ${WORKSPACE} \
  -scheme ${SCHEME} \
  -configuration Debug \
  -destination ${destination} \
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

// Install. CoreDevice `devicectl` needs a live DDI tunnel and remaps offline
// UDIDs to ecid_* (error 1011). USB lockdown via ios-deploy still works.
const installIds = [...new Set([deviceUdid, target?.hardwareProperties?.udid, target?.identifier, ...usbUdids].filter(Boolean))]
let installedId
for (const id of installIds) {
  const install = await $({nothrow: true, stdio: "inherit"})`xcrun devicectl device install app --device ${id} ${appPath}`
  if (install.exitCode === 0) {
    installedId = id
    break
  }
}
if (!installedId) {
  console.warn("devicectl has no CoreDevice tunnel; installing over USB with ios-deploy.")
  const deploy = await $({nothrow: true})`ios-deploy --bundle ${appPath} --id ${deviceUdid} --justlaunch --no-wifi --noninteractive`
  const deployText = `${deploy.stdout}${deploy.stderr}`
  process.stdout.write(deployText)
  if (/InstallComplete|Installed package/.test(deployText)) {
    installedId = deviceUdid
    if (deploy.exitCode !== 0) {
      console.warn("App installed over USB. CoreDevice/DDI launch failed — tap Mentra on the phone if it did not open.")
    }
  } else {
    console.error("Could not install the app over USB.")
    console.error("Unlock the phone, keep the cable plugged in, tap Trust, then retry.")
    console.error("Need ios-deploy on PATH (`brew install ios-deploy`).")
    process.exit(1)
  }
}
if (installedId) {
  const launch = await $({nothrow: true, stdio: "inherit"})`xcrun devicectl device process launch --device ${installedId} ${BUNDLE_ID}`
  if (launch.exitCode !== 0) {
    console.warn("devicectl could not launch the app. It is installed — open Mentra on the phone.")
  }
}

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
