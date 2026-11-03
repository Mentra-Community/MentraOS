#!/usr/bin/env node

import {spawn, spawnSync} from "node:child_process"
import {setTimeout as delay} from "node:timers/promises"
import {expoDeviceName, resolveAndroidPhoneTarget} from "./resolve-android-phone.mjs"

const port = Number(process.env.EXPO_DEV_SERVER_PORT || process.env.RCT_METRO_PORT || 8081)
const metroHost = process.env.EXPO_DEV_SERVER_HOST || "localhost"
const scheme = process.env.EXPO_DEV_CLIENT_SCHEME || "exp+mentra-sdk-rn-example"
const appId = process.env.EXPO_ANDROID_APP_ID || "com.mentra.bluetoothsdk.example.reactnative"
const metroUrl = `http://${metroHost}:${port}`
const devClientUrl = `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`

process.env.REACT_NATIVE_PACKAGER_HOSTNAME ||= metroHost

const args = new Set(process.argv.slice(2))
if (args.has("-h") || args.has("--help")) {
  console.log(`
Usage:
  bun run android:dev

Starts Metro first, installs/runs the Android development build on a connected
phone (never Mentra Live glasses), without spawning a second bundler, then
explicitly opens the Expo dev-client URL.

Environment overrides:
  EXPO_DEV_SERVER_PORT       Metro port. Defaults to 8081.
  EXPO_DEV_SERVER_HOST       Metro host in the dev-client URL. Defaults to localhost.
  EXPO_DEV_CLIENT_SCHEME     Dev-client scheme. Defaults to exp+mentra-sdk-rn-example.
  EXPO_ANDROID_APP_ID        Android app id. Defaults to com.mentra.bluetoothsdk.example.reactnative.
  ANDROID_SERIAL             Force a specific phone serial when multiple phones are connected.
  ALLOW_MENTRA_LIVE=1        Allow targeting Mentra Live (not recommended for this example).
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
  const target = resolveAndroidPhoneTarget()
  const serial = target.serial
  const deviceName = expoDeviceName(target)
  let metroProcess = null

  console.log(`Using Android phone: ${deviceName} (serial ${serial})`)

  if (await isMetroRunning()) {
    console.log(`Metro is already running at ${metroUrl}`)
  } else {
    console.log(`Starting Metro at ${metroUrl}`)
    metroProcess = spawn(
      "bunx",
      ["expo", "start", "--dev-client", "--host", "localhost", "--port", String(port)],
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
  run("bunx", ["expo", "run:android", "--no-bundler", "--device", deviceName])

  console.log(`Opening Expo dev-client URL: ${devClientUrl}`)
  run("adb", ["-s", serial, "shell", "am", "force-stop", appId])
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
