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
const mobileSdkRoot = path.resolve(projectRoot, "../../../mobile/modules/bluetooth-sdk")
const modulesSdkPath = path.join(projectRoot, "modules/bluetooth-sdk")

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

/**
 * Expo autolinking prefers `modules/bluetooth-sdk` over node_modules when present.
 * A stale copied tree there ignores package.json `file:` — symlink to mobile SDK instead.
 */
function ensureBluetoothSdkSymlink() {
  if (!fs.existsSync(mobileSdkRoot)) {
    console.warn(`Mobile SDK not found at ${mobileSdkRoot} — skipping modules/ symlink fix`)
    return
  }

  const expected = fs.realpathSync(mobileSdkRoot)

  // Broken symlinks: existsSync is false but lstat still finds the link (EEXIST if we skip rm).
  let hasModulesEntry = false
  try {
    fs.lstatSync(modulesSdkPath)
    hasModulesEntry = true
  } catch {
    /* path absent */
  }

  if (hasModulesEntry) {
    try {
      if (fs.realpathSync(modulesSdkPath) === expected) {
        console.log(`modules/bluetooth-sdk -> ${expected}`)
        return
      }
      console.log(`Replacing modules/bluetooth-sdk (was not ${expected})`)
    } catch {
      console.warn("Removing broken modules/bluetooth-sdk symlink")
    }
    const stat = fs.lstatSync(modulesSdkPath)
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(modulesSdkPath)
    } else {
      fs.rmSync(modulesSdkPath, {recursive: true, force: true})
    }
  }

  // Use absolute target — relative ../../../ paths break from modules/ (ENOENT on realpath).
  fs.symlinkSync(expected, modulesSdkPath, "dir")
  console.log(`Linked modules/bluetooth-sdk -> ${expected}`)
}

/**
 * bluetooth-sdk depends on :lc3Lib and :silero. Published npm tarballs may omit silero;
 * local dev uses modules/bluetooth-sdk -> MentraOS/mobile/modules/bluetooth-sdk.
 */
function ensureSettingsGradleNativeModules() {
  const settingsPath = path.join(projectRoot, "android/settings.gradle")
  if (!fs.existsSync(settingsPath)) {
    console.warn("android/settings.gradle missing — run: bunx expo prebuild --platform android")
    return
  }

  if (!fs.existsSync(mobileSdkRoot)) {
    return
  }

  const sdkRoot = fs.realpathSync(mobileSdkRoot)
  const sdkRootLiteral = JSON.stringify(sdkRoot)

  let contents = fs.readFileSync(settingsPath, "utf8")

  const rootBlock = `def mentraBluetoothSdkRoot = new File(${sdkRootLiteral})`

  contents = contents.replace(
    /def mentraBluetoothSdkPackageJson[\s\S]*?def mentraBluetoothSdkRoot = new File\(mentraBluetoothSdkPackageJson\)\.getParentFile\(\)\s*\n?/,
    `${rootBlock}\n`,
  )

  if (!contents.includes("def mentraBluetoothSdkRoot")) {
    contents += `\n${rootBlock}\n`
  }

  if (!contents.includes("include ':lc3Lib'")) {
    contents += `
include ':lc3Lib'
project(':lc3Lib').projectDir = new File(mentraBluetoothSdkRoot, 'android/lc3Lib')
`
  }

  if (!contents.includes("include ':silero'")) {
    contents += `
include ':silero'
project(':silero').projectDir = new File(mentraBluetoothSdkRoot, 'android/silero')
`
  }

  fs.writeFileSync(settingsPath, contents)
  console.log(`android/settings.gradle uses bluetooth-sdk at ${sdkRoot}`)
}

/** Root project must see bluetooth-sdk's on-disk Maven repo (AAR downloaded in SDK build.gradle). */
function ensureSherpaOnnxMavenRepo() {
  const buildGradlePath = path.join(projectRoot, "android/build.gradle")
  if (!fs.existsSync(buildGradlePath) || !fs.existsSync(mobileSdkRoot)) {
    return
  }

  const marker = "// bluetooth-sdk: sherpa-onnx local maven repo"
  let contents = fs.readFileSync(buildGradlePath, "utf8")
  if (contents.includes(marker)) {
    return
  }

  const repoDir = path.join(fs.realpathSync(mobileSdkRoot), "android/libs/maven")
  const repoBlock = `    maven {\n      ${marker}\n      url = uri(${JSON.stringify(repoDir)})\n    }`

  const match = contents.match(/allprojects\s*\{[\s\S]*?repositories\s*\{/)
  if (!match) {
    console.warn("android/build.gradle: no allprojects.repositories block — add Sherpa maven repo manually")
    return
  }

  const insertIdx = match.index + match[0].length
  contents = contents.slice(0, insertIdx) + "\n" + repoBlock + contents.slice(insertIdx)
  fs.writeFileSync(buildGradlePath, contents)
  console.log(`android/build.gradle: Sherpa-ONNX maven -> ${repoDir}`)
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

// Metro and native must use the same SDK tree (local mobile has silero + photo-receiver).
if (fs.existsSync(mobileSdkRoot)) {
  process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH = fs.realpathSync(mobileSdkRoot)
}

const target = resolveAndroidPhoneTarget()
const expoDevice = expoDeviceName(target)

const sdkPkg = output("node", [
  "--print",
  "require.resolve('@mentra/bluetooth-sdk/package.json')",
])
console.log(`@mentra/bluetooth-sdk resolves to: ${sdkPkg}`)
console.log(
  "Local SDK: run `bun install` after adding new .java files (file: deps use per-file symlinks).",
)
console.log(`Using Android phone: ${expoDevice} (serial ${target.serial})`)
console.log("Skipping Mentra Live / emulator targets.")

ensureBluetoothSdkSymlink()
ensureSettingsGradleNativeModules()
ensureSherpaOnnxMavenRepo()

// Refresh file: symlinks so new SDK sources are visible to Gradle.
console.log("Refreshing @mentra/bluetooth-sdk symlinks (bun install)...")
run("bun", ["install"])

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
