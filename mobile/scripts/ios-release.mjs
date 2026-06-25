#!/usr/bin/env zx
import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

const installOnly = process.env.IOS_RELEASE_INSTALL_ONLY === "1"

if (installOnly) {
  console.log("Install-only mode (IOS_RELEASE_INSTALL_ONLY=1)")
} else {
  console.log("Building iOS release...")

  // prebuild ios:
  await $({stdio: "inherit"})`bun expo prebuild --platform ios`

  // copy .env to ios/.xcode.env.local:
  await $({stdio: "inherit"})`cp .env ios/.xcode.env.local`

  // Sync CocoaPods after prebuild so new native source files are compiled
  await $({stdio: "inherit", cwd: "ios"})`pod install`
}

function isIphone(device) {
  return (
    device.hardwareProperties?.deviceType === "iPhone" ||
    device.capabilities?.some((c) => c.name === "iPhone") ||
    device.deviceProperties?.marketingName?.includes("iPhone")
  )
}

function isPairedIphone(device) {
  return isIphone(device) && device.connectionProperties?.pairingState === "paired"
}

function isInstallableIphone(device) {
  if (!isPairedIphone(device)) return false
  const tunnel = device.connectionProperties?.tunnelState
  if (tunnel === "unavailable") return false
  if (tunnel === "connected") return true
  return (
    tunnel === "disconnected" &&
    device.connectionProperties?.transportType === "wired" &&
    device.deviceProperties?.bootState === "booted"
  )
}

function toDeviceRef(device) {
  return {
    udid: device.hardwareProperties.udid,
    name: device.deviceProperties.name,
    coreDeviceId: device.identifier,
    tunnelConnected: device.connectionProperties?.tunnelState === "connected",
  }
}

async function listDevicesViaDevicectl() {
  const tmpFile = `/tmp/devicectl-${Date.now()}.json`
  try {
    await $`xcrun devicectl list devices --json-output ${tmpFile} --timeout 5`
    const json = JSON.parse(await fs.readFile(tmpFile, "utf-8"))
    return json.result?.devices ?? []
  } catch (error) {
    const message = String(error?.message ?? error)
    if (/not found|unable to find utility|No such file/i.test(message)) {
      console.warn("devicectl unavailable, falling back to simulator:", message)
      return null
    }
    throw error
  } finally {
    await fs.remove(tmpFile).catch(() => {})
  }
}

async function getOnlineIphoneUdids() {
  const output = (await $`xcrun xctrace list devices`.quiet()).stdout
  const udids = []
  let inOnline = false
  for (const line of output.split("\n")) {
    if (line.includes("== Devices ==")) {
      inOnline = true
      continue
    }
    if (line.includes("== Devices Offline ==")) break
    if (!inOnline) continue
    const match = line.match(/\(([0-9A-Fa-f-]{25,})\)\s*$/)
    if (match && /iphone/i.test(line)) udids.push(match[1])
  }
  return udids
}

function pickInstallableIphone(devices) {
  if (!devices) return null
  const installable = devices.filter(isInstallableIphone)
  if (!installable.length) return null

  const connected = installable.find(
    (d) => d.connectionProperties?.tunnelState === "connected",
  )
  return toDeviceRef(connected ?? installable[0])
}

function pickIphoneByUdid(devices, udid) {
  const device = devices?.find((d) => isIphone(d) && d.hardwareProperties?.udid === udid)
  return device ? toDeviceRef(device) : null
}

async function waitForInstallableIphone({maxAttempts = 45, intervalMs = 2000} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const devices = await listDevicesViaDevicectl()
    const picked = pickInstallableIphone(devices)
    if (picked) return picked

    const onlineUdids = await getOnlineIphoneUdids()
    for (const udid of onlineUdids) {
      const matched = pickIphoneByUdid(devices, udid)
      if (matched) return matched
    }

    const pairedIphones = devices?.filter(isPairedIphone) ?? []
    if (pairedIphones.length > 0) {
      const offline = pairedIphones[0]
      console.log(
        `Waiting for iPhone "${offline.deviceProperties.name}" (${attempt}/${maxAttempts}, tunnel: ${offline.connectionProperties.tunnelState})...`,
      )
    } else if (devices) {
      console.log(`Waiting for a paired iPhone (${attempt}/${maxAttempts})...`)
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  return null
}

async function findReleaseAppPath() {
  const derivedData = (
    await $`ls -td ~/Library/Developer/Xcode/DerivedData/MentraOS-*`.quiet()
  ).stdout
    .trim()
    .split("\n")[0]
  return `${derivedData}/Build/Products/Release-iphoneos/Mentra.app`
}

async function installWithDevicectl(deviceRef, appPath) {
  console.log(`Installing via devicectl: ${appPath}`)
  const deviceFlags = [deviceRef.coreDeviceId, deviceRef.udid]

  for (let attempt = 1; attempt <= 60; attempt++) {
    for (const deviceId of deviceFlags) {
      try {
        await $({
          stdio: "inherit",
        })`xcrun devicectl device install app --device ${deviceId} ${appPath}`
        return
      } catch (error) {
        const message = String(error?.message ?? error)
        if (!/unable to locate a device|error 1011|not connected/i.test(message)) {
          throw error
        }
      }
    }

    console.log(
      `Device not reachable for install (${attempt}/60) — plug in via USB, unlock iPhone, tap Trust...`,
    )
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  throw new Error(
    "Install failed: iPhone not reachable. Plug in via USB, unlock, tap Trust, then run: IOS_RELEASE_INSTALL_ONLY=1 bun ios:release",
  )
}

const waitOptions = installOnly ? {maxAttempts: 90, intervalMs: 2000} : {}
const device = await waitForInstallableIphone(waitOptions)

if (!device) {
  const devices = await listDevicesViaDevicectl()
  const pairedIphones = devices?.filter(isPairedIphone) ?? []

  if (installOnly) {
    console.error("Install failed: no reachable iPhone detected.")
    if (pairedIphones.length > 0) {
      console.error(
        `Known device: "${pairedIphones[0].deviceProperties.name}" — plug in via USB, unlock, tap Trust, then retry.`,
      )
    }
    process.exit(1)
  }

  if (pairedIphones.length > 0) {
    const offline = pairedIphones[0]
    console.error(
      `iPhone "${offline.deviceProperties.name}" is paired but not reachable (tunnel: ${offline.connectionProperties.tunnelState}).`,
    )
    console.error(
      "Plug in via USB, unlock the device, tap Trust on the device, then retry.",
    )
    process.exit(1)
  }

  console.log("No physical iPhone connected — building release for iOS Simulator")
  await $({stdio: "inherit"})`bun expo run:ios --configuration Release --no-bundler`
  console.log("✅ iOS release built and installed on Simulator!")
  process.exit(0)
}

console.log(
  `Using device: ${device.name} (${device.udid})${device.tunnelConnected ? "" : " [devicectl install]"}`,
)

if (installOnly) {
  const appPath = await findReleaseAppPath()
  if (!(await fs.pathExists(appPath))) {
    console.error(`No Release build found at ${appPath}. Run bun ios:release first.`)
    process.exit(1)
  }
  await installWithDevicectl(device, appPath)
  console.log("✅ iOS release installed successfully!")
  process.exit(0)
}

let installed = false
try {
  await $({
    stdio: "inherit",
  })`bun expo run:ios --device ${device.udid} --configuration Release --no-bundler`
  installed = device.tunnelConnected
} catch (error) {
  const appPath = await findReleaseAppPath()
  if (!(await fs.pathExists(appPath))) {
    throw error
  }
  console.warn("expo run:ios failed after build; finishing install with devicectl")
  await installWithDevicectl(device, appPath)
  installed = true
}

if (!installed) {
  const appPath = await findReleaseAppPath()
  if (await fs.pathExists(appPath)) {
    await installWithDevicectl(device, appPath)
  }
}

console.log("✅ iOS release built and installed successfully!")
