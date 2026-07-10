#!/usr/bin/env node

/**
 * Run expo on a physical phone, not Mentra Live glasses.
 * MentraOS mobile/scripts/android.mjs uses the same "exclude live" rule.
 */

import {spawnSync} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {expoDeviceName, resolveAndroidPhoneTarget} from "./resolve-android-phone.mjs"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, "..")
const modulesSdkPath = path.join(projectRoot, "modules/bluetooth-sdk")
const localSdkOverride = process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH?.trim()
  ? path.resolve(process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH)
  : null

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
  MENTRA_BLUETOOTH_SDK_PACKAGE_PATH
                        Explicitly use a local SDK source checkout instead of npm
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

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {stdio: "inherit", env: process.env})
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function removeStaleBluetoothSdkModuleEntry() {
  try {
    const stat = fs.lstatSync(modulesSdkPath)
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(modulesSdkPath)
    } else {
      fs.rmSync(modulesSdkPath, {recursive: true, force: true})
    }
    console.log("Removed modules/bluetooth-sdk so Expo autolinks the npm dependency")
  } catch {
    /* path absent */
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

const target = resolveAndroidPhoneTarget()
const expoDevice = expoDeviceName(target)

removeStaleBluetoothSdkModuleEntry()

console.log("Installing the package.json dependencies from npm...")
run("bun", ["install"])

const sdkPackageJson = output("node", [
  "--print",
  "require.resolve('@mentra/bluetooth-sdk/package.json')",
]).trim()
if (localSdkOverride && !fs.existsSync(localSdkOverride)) {
  throw new Error(`Local SDK override not found at ${localSdkOverride}`)
}
const sdkRoot = localSdkOverride
  ? fs.realpathSync(localSdkOverride)
  : path.dirname(fs.realpathSync(sdkPackageJson))
const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"))
console.log(`@mentra/bluetooth-sdk resolves to: ${sdkRoot} (version ${sdkPackage.version})`)
console.log(localSdkOverride ? "SDK source: explicit local override" : "SDK source: npm dependency")
console.log(`Using Android phone: ${expoDevice} (serial ${target.serial})`)
console.log("Skipping Mentra Live / emulator targets.")

if (!fs.existsSync(path.join(projectRoot, "android/settings.gradle"))) {
  console.log("Generating the Android project...")
  run("bunx", ["expo", "prebuild", "--platform", "android"])
}

const skipClean = process.env.SDK_CLEAN === "0"
if (!skipClean) {
  // Full `./gradlew clean` breaks RN CMake clean (webview codegen jni missing). Only reset the SDK module.
  console.log(
    "Recompiling mentra-bluetooth-sdk (SDK_CLEAN=0 skips; SDK_FULL_CLEAN=1 runs full gradlew clean — may fail on CMake).",
  )
  run("bash", [
    "-lc",
    "cd android && ./gradlew :mentra-bluetooth-sdk:clean :mentra-bluetooth-sdk:compileDebugJavaWithJavac --rerun-tasks -q",
  ])
}

if (process.env.SDK_FULL_CLEAN === "1") {
  console.warn("SDK_FULL_CLEAN=1: running full ./gradlew clean (CMake recovery runs next).")
  run("bash", ["-lc", "cd android && ./gradlew clean"])
}

// Always recover after partial/full cleans so configureCMakeDebug does not fail on webview jni.
recoverAndroidNativeBuild()

run("bunx", ["expo", "run:android", "--device", expoDevice, ...args])
