#!/usr/bin/env node

import {spawn, spawnSync} from "node:child_process"
import {setTimeout as delay} from "node:timers/promises"

const port = Number(process.env.EXPO_DEV_SERVER_PORT || process.env.RCT_METRO_PORT || 8081)
const scheme = process.env.EXPO_DEV_CLIENT_SCHEME || "exp+mentra-example"
const appId = process.env.EXPO_ANDROID_APP_ID || "com.mentra.bluetoothsdk.example"
const metroUrl = `http://127.0.0.1:${port}`
const devClientUrl = `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`

const args = new Set(process.argv.slice(2))
if (args.has("-h") || args.has("--help")) {
  console.log(`
Usage:
  npm run android:dev

Starts Metro first, installs/runs the Android development build without
spawning a second bundler, then explicitly opens the Expo dev-client URL.

Environment overrides:
  EXPO_DEV_SERVER_PORT       Metro port. Defaults to 8081.
  EXPO_DEV_CLIENT_SCHEME     Dev-client scheme. Defaults to exp+mentra-example.
  EXPO_ANDROID_APP_ID        Android app id. Defaults to com.mentra.bluetoothsdk.example.
  ANDROID_SERIAL             Required when multiple Android devices are connected.
`)
  process.exit(0)
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    encoding: "utf8",
    ...options,
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${result.status}`)
  }
}

function output(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${commandArgs.join(" ")} failed`)
  }

  return result.stdout
}

function resolveAndroidSerial() {
  const requestedSerial = process.env.ANDROID_SERIAL?.trim()
  const lines = output("adb", ["devices"])
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)

  const devices = lines
    .map((line) => {
      const [serial, state] = line.split(/\s+/)
      return {serial, state}
    })
    .filter((device) => device.state === "device")

  if (requestedSerial) {
    if (!devices.some((device) => device.serial === requestedSerial)) {
      throw new Error(`ANDROID_SERIAL=${requestedSerial} is not an attached, authorized Android device.`)
    }
    return requestedSerial
  }

  if (devices.length === 0) {
    throw new Error("No authorized Android device found. Connect a phone and accept the USB debugging prompt.")
  }

  if (devices.length > 1) {
    const list = devices.map((device) => `  - ${device.serial}`).join("\n")
    throw new Error(`Multiple Android devices are connected. Set ANDROID_SERIAL to one of:\n${list}`)
  }

  return devices[0].serial
}

async function isMetroRunning() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1000)

  try {
    const response = await fetch(`${metroUrl}/status`, {signal: controller.signal})
    const text = await response.text()
    return text.includes("packager-status:running")
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForMetro() {
  const deadline = Date.now() + 90_000

  while (Date.now() < deadline) {
    if (await isMetroRunning()) {
      return
    }
    await delay(500)
  }

  throw new Error(`Metro did not become ready at ${metroUrl} within 90 seconds.`)
}

async function main() {
  const serial = resolveAndroidSerial()
  let metroProcess = null

  if (await isMetroRunning()) {
    console.log(`Metro is already running at ${metroUrl}`)
  } else {
    console.log(`Starting Metro at ${metroUrl}`)
    metroProcess = spawn(
      "npx",
      ["expo", "start", "--dev-client", "--localhost", "--port", String(port)],
      {
        stdio: "inherit",
        env: process.env,
      },
    )

    metroProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Metro exited with code ${code}`)
        process.exitCode = code
      }
    })

    await waitForMetro()
  }

  console.log(`Forwarding Android device localhost:${port} to this Mac`)
  run("adb", ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`])

  console.log("Installing and launching the Android development build")
  run("npx", ["expo", "run:android", "--no-bundler", "--port", String(port)])

  console.log(`Opening Expo dev-client URL: ${devClientUrl}`)
  run("adb", [
    "-s",
    serial,
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    devClientUrl,
    "-p",
    appId,
  ])

  if (!metroProcess) {
    console.log("Using existing Metro process; android:dev is done.")
    return
  }

  console.log("Metro is running. Press Ctrl-C to stop the dev server.")
  await new Promise((resolve) => {
    const stop = () => {
      metroProcess.kill("SIGINT")
      resolve()
    }

    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    metroProcess.on("exit", resolve)
  })
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
