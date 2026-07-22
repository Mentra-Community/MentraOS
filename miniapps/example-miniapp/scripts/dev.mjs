#!/usr/bin/env node

/**
 * Dev entry: ensure ElevenLabs signing server is up, then run mentra-miniapp dev.
 * Loads .env.local so ELEVENLABS_API_KEY / MENTRA_PUBLIC_* are available.
 */

import {spawn} from "node:child_process"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

import {loadEnvLocal} from "./load-env-local.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// Must load .env.local before reading ELEVENLABS_SIGNING_SERVER_PORT.
loadEnvLocal(root)

const port = Number(process.env.ELEVENLABS_SIGNING_SERVER_PORT || 8788)
const healthUrl = `http://127.0.0.1:${port}/health`

async function signerHealthy() {
  try {
    const res = await fetch(healthUrl, {signal: AbortSignal.timeout(1500)})
    return res.ok
  } catch {
    return false
  }
}

let signerChild = null

if (!(await signerHealthy())) {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn(
      `[dev] ElevenLabs signer not running on :${port} and ELEVENLABS_API_KEY is unset.\n` +
        `      Put the key in .env.local (or export it), then re-run bun run dev.\n` +
        `      Continuing without signer — ElevenLabs Start will fail until it is up.`,
    )
  } else {
    console.log(`[dev] starting ElevenLabs signer on :${port}`)
    signerChild = spawn(process.execPath, [join(root, "scripts/signed-url-server.mjs")], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    })
    signerChild.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        console.warn(`[dev] signer exited code=${code} signal=${signal ?? ""}`)
      }
      signerChild = null
    })
    // Brief wait so health is up before miniapp clients hit Start.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100))
      if (await signerHealthy()) break
    }
    if (!(await signerHealthy())) {
      console.warn(`[dev] signer did not become healthy on :${port}`)
    } else {
      console.log(`[dev] signer ready at http://0.0.0.0:${port}`)
    }
  }
} else {
  console.log(`[dev] ElevenLabs signer already healthy on :${port}`)
}

const miniapp = spawn("bunx", ["mentra-miniapp", "dev"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
})

function shutdown(signal) {
  if (miniapp && !miniapp.killed) miniapp.kill(signal)
  if (signerChild && !signerChild.killed) signerChild.kill(signal)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

miniapp.on("exit", (code) => {
  if (signerChild && !signerChild.killed) signerChild.kill("SIGTERM")
  process.exit(code ?? 0)
})
