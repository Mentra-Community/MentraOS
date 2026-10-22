#!/usr/bin/env node

/**
 * Run expo on a physical phone, not Mentra Live glasses.
 * MentraOS mobile/scripts/android.mjs uses the same "exclude live" rule.
 *
 * Fast path (default):
 *   - Skips the forced `:mentra-bluetooth-sdk:clean --rerun-tasks` pass
 *     that previously ran a full Gradle configure before `expo run:android`.
 *   - Builds arm64-v8a only (physical phones).
 *
 * Slow / force-refresh path:
 *   SDK_CLEAN=1 bun run android
 */

import {spawnSync} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {expoDeviceName, resolveAndroidPhoneTarget} from "./resolve-android-phone.mjs"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, "..")
const args = process.argv.slice(2)

if (args.includes("-h") || args.includes("--help")) {
  console.log(`
Usage:
  bun run android

Installs the development build on a connected Android phone (USB debugging).
Skips Mentra Live glasses and emulators unless ANDROID_SERIAL is set.

Environment:
  ANDROID_SERIAL        Force a specific phone serial when multiple phones are connected
  ALLOW_MENTRA_LIVE=1   Allow targeting Mentra Live (not recommended for this example)
  SDK_CLEAN=1           Force-clean + recompile mentra-bluetooth-sdk before install
                        (slow: full Gradle configure twice). Default is skip.
  SDK_FULL_CLEAN=1      Full ./gradlew clean (may fail on CMake; recovery runs after)
  REACT_NATIVE_ARCHITECTURES
                        ABI list for Gradle. Default: arm64-v8a (phones).
                        Use armeabi-v7a,arm64-v8a,x86,x86_64 for emulator coverage.
`)
  process.exit(0)
}

function output(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {encoding: "utf8"})
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} failed`)
  }
  return result.stdout
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    env: process.env,
    ...options,
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

/** Fix CMake/codegen after a failed `gradlew clean` (AGP bug 255965912 / missing webview jni). */
function recoverAndroidNativeBuild() {
  console.log("Recovering Android native build (reset .cxx + RN webview codegen)...")
  run("bash", [
    "-lc",
    [
      "cd android",
      "rm -rf app/.cxx",
      "./gradlew :react-native-webview:generateCodegenSchemaFromJavaScript :react-native-webview:generateCodegenArtifactsFromSchema -q",
    ].join(" && "),
  ])
}

function applyFastGradleDefaults() {
  // Physical phones are arm64. Building 4 ABIs (default Expo) multiplies native work.
  process.env.ORG_GRADLE_PROJECT_reactNativeArchitectures ||=
    process.env.REACT_NATIVE_ARCHITECTURES || "arm64-v8a"

  const gradleOpts = process.env.GRADLE_OPTS || ""
  const extras = []
  if (!gradleOpts.includes("org.gradle.caching")) {
    extras.push("-Dorg.gradle.caching=true")
  }
  if (!gradleOpts.includes("org.gradle.parallel")) {
    extras.push("-Dorg.gradle.parallel=true")
  }
  if (extras.length > 0) {
    process.env.GRADLE_OPTS = [gradleOpts, ...extras].filter(Boolean).join(" ").trim()
  }

  console.log(
    `Gradle ABIs: ${process.env.ORG_GRADLE_PROJECT_reactNativeArchitectures} (set REACT_NATIVE_ARCHITECTURES to override)`,
  )
}

const target = resolveAndroidPhoneTarget()
const expoDevice = expoDeviceName(target)

console.log("Installing dependencies...")
run("bun", ["install"], {cwd: projectRoot})

const sdkRoot = fs.realpathSync(
  path.dirname(output("node", ["--print", "require.resolve('@mentra/bluetooth-sdk/package.json')"]).trim()),
)
const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"))
console.log(`@mentra/bluetooth-sdk resolves to: ${sdkRoot} (version ${sdkPackage.version})`)
console.log(`Using Android phone: ${expoDevice} (serial ${target.serial})`)
console.log("Skipping Mentra Live / emulator targets.")

applyFastGradleDefaults()
if (!fs.existsSync(path.join(projectRoot, "android/settings.gradle"))) {
  console.log("Generating the Android project...")
  run("bunx", ["expo", "prebuild", "--platform", "android"])
}

// Opt-in only. Default used to always clean+--rerun-tasks, which forced a full
// Gradle configure before expo run:android did it again.
const forceClean = process.env.SDK_CLEAN === "1"
let didClean = false
if (forceClean) {
  console.log(
    "SDK_CLEAN=1: recompiling mentra-bluetooth-sdk (clean + --rerun-tasks). Omit SDK_CLEAN for the fast path.",
  )
  run("bash", [
    "-lc",
    "cd android && ./gradlew :mentra-bluetooth-sdk:clean :mentra-bluetooth-sdk:compileDebugJavaWithJavac --rerun-tasks -q",
  ])
  didClean = true
} else {
  console.log("Skipping forced SDK clean (set SDK_CLEAN=1 to force).")
}

if (process.env.SDK_FULL_CLEAN === "1") {
  console.warn("SDK_FULL_CLEAN=1: running full ./gradlew clean (CMake recovery runs next).")
  run("bash", ["-lc", "cd android && ./gradlew clean"])
  didClean = true
}

// Only recover after cleans so configureCMakeDebug does not fail on webview jni.
if (didClean) {
  recoverAndroidNativeBuild()
}

run("bunx", ["expo", "run:android", "--device", expoDevice, ...args])
