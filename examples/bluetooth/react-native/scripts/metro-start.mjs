#!/usr/bin/env node

/**
 * Start Expo Metro without prompting when the default port is busy.
 * Picks the next free port (8081, 8082, …) and passes --port to expo start.
 */

import {spawn} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {resolveMetroPort} from "./resolve-metro-port.mjs"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, "..")
const mobileSdkRoot = path.resolve(projectRoot, "../../../mobile/modules/bluetooth-sdk")

if (fs.existsSync(mobileSdkRoot)) {
  process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH = fs.realpathSync(mobileSdkRoot)
}

const preferred = Number(process.env.RCT_METRO_PORT || process.env.EXPO_DEV_SERVER_PORT || 8081)
const port = await resolveMetroPort(preferred)

if (port !== preferred) {
  console.log(`Port ${preferred} is in use; using ${port} instead.`)
}

process.env.RCT_METRO_PORT = String(port)
process.env.EXPO_DEV_SERVER_PORT = String(port)

const expoArgs = ["expo", "start", "--dev-client", "--port", String(port), ...process.argv.slice(2)]

const child = spawn("bunx", expoArgs, {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
