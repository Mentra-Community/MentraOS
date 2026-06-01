#!/usr/bin/env zx

// wireless-adb.mjs - switch a USB-connected Android device to wireless adb
// Usage: ./wireless-adb.mjs [--port 5555] [--metro 8081]

import "zx/globals"

const PORT = argv.port ?? 5555
const METRO_PORT = argv.metro ?? 8081

$.verbose = false

// --- 1. Check for a single USB-connected device ---
const devicesOutput = (await $`adb devices`).stdout
const devices = devicesOutput
  .split("\n")
  .slice(1)
  .map((l) => l.trim())
  .filter((l) => l.endsWith("\tdevice"))
  .map((l) => l.split("\t")[0])

if (devices.length === 0) {
  console.error(chalk.red("✗ No device connected via USB."))
  console.error("  Plug in a device with USB debugging enabled.")
  process.exit(1)
}

if (devices.length > 1) {
  console.error(chalk.red("✗ Multiple devices connected:"))
  devices.forEach((d) => console.error(`  - ${d}`))
  console.error("  Disconnect extras or set $ANDROID_SERIAL.")
  process.exit(1)
}

const serial = devices[0]
console.log(chalk.dim(`Device: ${serial}`))

// --- 2. Get the device's Wi-Fi IP ---
let ip
try {
  const out = (await $`adb -s ${serial} shell ip -f inet addr show wlan0`).stdout
  ip = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/)?.[1]
} catch {
  // fall through to fallback
}

if (!ip) {
  // fallback for devices where wlan0 isn't the right interface
  const route = (await $`adb -s ${serial} shell ip route`).stdout
  ip = route.match(/src\s+(\d+\.\d+\.\d+\.\d+)/)?.[1]
}

if (!ip) {
  console.error(chalk.red("✗ Could not determine device Wi-Fi IP."))
  console.error("  Is the device connected to Wi-Fi?")
  process.exit(1)
}

console.log(chalk.dim(`IP: ${ip}`))

// --- 3. Switch to TCP mode ---
console.log(`Switching adb to TCP mode on port ${PORT}...`)
await $`adb -s ${serial} tcpip ${PORT}`
await sleep(2000)

// --- 4. Connect wirelessly ---
const target = `${ip}:${PORT}`
const connectOut = (await $`adb connect ${target}`).stdout.trim()

if (!connectOut.includes("connected")) {
  console.error(chalk.red(`✗ Connection failed: ${connectOut}`))
  process.exit(1)
}

await sleep(500)

// --- 5. Verify and set up Metro reverse ---
const verify = (await $`adb devices`).stdout
if (!verify.includes(`${target}\tdevice`)) {
  console.error(chalk.red("✗ Device did not appear as wireless after connect."))
  process.exit(1)
}

console.log(chalk.green(`✓ Wireless adb connected at ${target}`))

await $`adb -s ${target} reverse tcp:${METRO_PORT} tcp:${METRO_PORT}`
console.log(chalk.green(`✓ Metro port ${METRO_PORT} forwarded`))

console.log(chalk.cyan("\nYou can now unplug USB."))

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
