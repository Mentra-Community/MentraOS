#!/usr/bin/env node
import {spawn} from "node:child_process"
import {readFileSync} from "node:fs"
import path from "node:path"
import {setTimeout as delay} from "node:timers/promises"
import {fileURLToPath} from "node:url"

// Retry the installer, never Gradle: a compilation or test failure must remain a failure.
const TRANSIENT =
  /Archive is not a ZIP archive|Error on ZipFile|Not in GZIP format|Unexpected end of (?:ZLIB input stream|file)|checksum.*(?:mismatch|failed)|Connection (?:reset|timed out)|Read timed out|SocketTimeoutException|EOFException|UnknownHostException|HTTP(?: response code:|\s+)\s*(?:408|429|500|502|503|504)\b/i
const PERMANENT =
  /Failed to find package|Unknown (?:argument|option)|licenses?.*(?:not accepted|not been accepted)|No space left on device|Permission denied/i

export function mobilePackages(mobileDir) {
  const versions = readFileSync(path.join(mobileDir, "node_modules/react-native/gradle/libs.versions.toml"), "utf8")
  const version = (key) => {
    const value = versions.match(new RegExp(`^${key} = "([0-9.]+)"`, "m"))?.[1]
    if (!value) throw new Error(`Missing ${key} in the installed React Native toolchain`)
    return value
  }
  const lc3 = readFileSync(path.join(mobileDir, "modules/bluetooth-sdk/android/lc3Lib/build.gradle"), "utf8")
  const lc3Sdk = lc3.match(/\bcompileSdk\s+(\d+)\b/)?.[1]
  const lc3Cmake = lc3.match(/cmake\s*\{[^}]*\bversion\s+['"]([0-9.]+)['"]/s)?.[1]
  if (!lc3Sdk || !lc3Cmake) throw new Error("Cannot resolve the lc3Lib Android toolchain")
  return [
    ...new Set([
      "platform-tools",
      `platforms;android-${version("compileSdk")}`,
      `build-tools;${version("buildTools")}`,
      `platforms;android-${lc3Sdk}`,
      // react-native-wifi-reborn's unquoted safeExtGet key falls back to API 31.
      "platforms;android-31",
      `ndk;${version("ndkVersion")}`,
      `cmake;${lc3Cmake}`,
    ]),
  ]
}

function runInstaller(command, packageId, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["--install", packageId], {stdio: ["ignore", "pipe", "pipe"]})
    let tail = ""
    let transient = false
    let permanent = false
    let cancelled = null
    const capture = (chunk) => {
      output.write(chunk)
      tail = (tail + chunk.toString()).slice(-128 * 1024)
      transient ||= TRANSIENT.test(tail)
      permanent ||= PERMANENT.test(tail)
    }
    child.stdout.on("data", capture)
    child.stderr.on("data", capture)
    const interrupt = () => {
      cancelled = "SIGINT"
      child.kill("SIGINT")
    }
    const terminate = () => {
      cancelled = "SIGTERM"
      child.kill("SIGTERM")
    }
    process.once("SIGINT", interrupt)
    process.once("SIGTERM", terminate)
    const cleanup = () => {
      process.removeListener("SIGINT", interrupt)
      process.removeListener("SIGTERM", terminate)
    }
    child.once("error", (error) => {
      cleanup()
      reject(error)
    })
    child.once("close", (code, signal) => {
      cleanup()
      resolve({code, signal: cancelled || signal, transient, permanent})
    })
  })
}

export async function installPackages(
  packages,
  {command = "sdkmanager", delayMs = 10_000, output = process.stdout} = {},
) {
  if (
    !packages.length ||
    packages.some((id) => !/^(?:platform-tools|(?:platforms;android-|build-tools;|ndk;|cmake;)[0-9.]+)$/.test(id))
  ) {
    throw new Error("Expected Android SDK package IDs, or --mobile <mobile-directory>")
  }
  for (const packageId of [...new Set(packages)]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      output.write(`Installing ${packageId} (attempt ${attempt}/3)\n`)
      const result = await runInstaller(command, packageId, output)
      // Some SDK manager versions log a failed archive preparation but return zero.
      if (result.code === 0 && !result.transient && !result.permanent && !result.signal) break
      if (result.signal || result.permanent || !result.transient || attempt === 3) {
        const error = new Error(`Android SDK installation failed for ${packageId}; attempt ${attempt}/3`)
        error.exitCode = result.signal ? (result.signal === "SIGINT" ? 130 : 143) : result.code || 1
        throw error
      }
      output.write(
        `::warning::Transient download failure for ${packageId}; retrying in ${(delayMs * attempt) / 1000}s.\n`,
      )
      await delay(delayMs * attempt)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const packages = args[0] === "--mobile" && args.length === 2 ? mobilePackages(args[1]) : args
    await installPackages(packages)
  } catch (error) {
    console.error(error.message)
    process.exitCode = error.exitCode || 1
  }
}
