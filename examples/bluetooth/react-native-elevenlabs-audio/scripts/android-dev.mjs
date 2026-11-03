#!/usr/bin/env node

import {spawn, spawnSync} from "node:child_process"
import {setTimeout as delay} from "node:timers/promises"

const DEFAULT_AGENT_ID = "agent_0301ks3wg64pf9evgxqa6dw34t1f"
const port = Number(process.env.EXPO_DEV_SERVER_PORT || process.env.RCT_METRO_PORT || 8082)
const metroHost = process.env.EXPO_DEV_SERVER_HOST || "localhost"
const signingPort = Number(process.env.ELEVENLABS_SIGNING_SERVER_PORT || 8788)
const scheme = process.env.EXPO_DEV_CLIENT_SCHEME || "exp+mentra-elevenlabs-audio"
const appId = process.env.EXPO_ANDROID_APP_ID || "com.mentra.elevenlabsaudio"
const metroUrl = `http://${metroHost}:${port}`
const signedUrlEndpoint = process.env.EXPO_PUBLIC_ELEVENLABS_SIGNED_URL_ENDPOINT || `http://localhost:${signingPort}/signed-url`
const devClientUrl = `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`

process.env.REACT_NATIVE_PACKAGER_HOSTNAME ||= metroHost
process.env.RCT_METRO_PORT ||= String(port)
process.env.EXPO_PUBLIC_ELEVENLABS_AGENT_ID ||= process.env.ELEVENLABS_AGENT_ID || DEFAULT_AGENT_ID
process.env.EXPO_PUBLIC_ELEVENLABS_SIGNED_URL_ENDPOINT ||= signedUrlEndpoint

const args = new Set(process.argv.slice(2))
if (args.has("-h") || args.has("--help")) {
  console.log(`
Usage:
  bun run android:dev

Environment:
  ELEVENLABS_API_KEY            Required. Stays in the local signing server.
  ELEVENLABS_AGENT_ID           Defaults to the repro agent id.
  ELEVENLABS_SIGNING_SERVER_PORT Defaults to 8788.
  EXPO_DEV_SERVER_PORT          Defaults to 8082.
  ANDROID_SERIAL                Required when multiple Android devices are connected.
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
  const result = spawnSync(command, commandArgs, {encoding: "utf8"})
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
    throw new Error("No authorized Android device found.")
  }

  if (devices.length > 1) {
    const list = devices.map((device) => `  - ${device.serial}`).join("\n")
    throw new Error(`Multiple Android devices are connected. Set ANDROID_SERIAL to one of:\n${list}`)
  }

  return devices[0].serial
}

async function health(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1000)
  try {
    const response = await fetch(url, {signal: controller.signal})
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function waitFor(url, label) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (await health(url)) {
      return
    }
    await delay(500)
  }
  throw new Error(`${label} did not become ready at ${url} within 90 seconds.`)
}

async function main() {
  const serial = resolveAndroidSerial()
  let metroProcess = null
  let signingProcess = null

  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is required. Put it in .env.local and source it before running this script.")
  }

  if (await health(`http://localhost:${signingPort}/health`)) {
    console.log(`Signing server is already running at http://localhost:${signingPort}`)
  } else {
    console.log(`Starting signing server at http://localhost:${signingPort}`)
    signingProcess = spawn("node", ["./scripts/signed-url-server.mjs"], {
      stdio: "inherit",
      env: process.env,
    })
    await waitFor(`http://localhost:${signingPort}/health`, "Signing server")
  }

  if (await health(`${metroUrl}/status`)) {
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
    await waitFor(`${metroUrl}/status`, "Metro")
  }

  console.log(`Forwarding Android localhost:${port} and localhost:${signingPort}`)
  run("adb", ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`])
  run("adb", ["-s", serial, "reverse", `tcp:${signingPort}`, `tcp:${signingPort}`])

  console.log("Installing and launching the Android development build")
  run("bunx", ["expo", "run:android", "--no-bundler"])

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

  console.log("Metro and signing server are running. Press Ctrl-C to stop them.")
  await new Promise((resolve) => {
    const stop = () => {
      metroProcess?.kill("SIGINT")
      signingProcess?.kill("SIGINT")
      resolve()
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    metroProcess?.on("exit", resolve)
    signingProcess?.on("exit", resolve)
  })
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
