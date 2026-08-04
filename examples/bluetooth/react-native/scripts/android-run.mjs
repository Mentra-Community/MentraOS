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
const modulesSdkPath = path.join(projectRoot, "modules/bluetooth-sdk")
/** MentraOS checkout layouts: nested under MentraOS/ or sibling of MentraOS/. */
const mentraOsSdkCandidates = [
  path.resolve(projectRoot, "../../../mobile/modules/bluetooth-sdk"),
  path.resolve(projectRoot, "../../../../mobile/modules/bluetooth-sdk"),
]
function resolveMentraOsSdkSibling() {
  for (const candidate of mentraOsSdkCandidates) {
    if (
      fs.existsSync(path.join(candidate, "package.json")) &&
      fs.existsSync(
        path.join(
          candidate,
          "android/src/main/java/com/mentra/bluetoothsdk/BluetoothSdkModule.kt",
        ),
      )
    ) {
      return candidate
    }
  }
  return null
}
const mentraOsSdkSibling = resolveMentraOsSdkSibling()
const localSdkOverride = process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH?.trim()
  ? path.resolve(process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH)
  : mentraOsSdkSibling &&
      fs
        .readFileSync(
          path.join(
            mentraOsSdkSibling,
            "android/src/main/java/com/mentra/bluetoothsdk/BluetoothSdkModule.kt",
          ),
          "utf8",
        )
        .includes("setWifiAdbState")
    ? mentraOsSdkSibling
    : null
if (localSdkOverride && !process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH?.trim()) {
  process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH = localSdkOverride
  console.log(
    `Auto-using MentraOS Bluetooth SDK (includes setWifiAdbState): ${localSdkOverride}`,
  )
}

const STUB_SHERPA_TRANSCRIBER = `package com.mentra.bluetoothsdk.stt

import android.content.Context
import com.mentra.bluetoothsdk.Bridge

/**
 * Compatibility shell for the optional local STT integration.
 *
 * Local Sherpa-ONNX transcription is not bundled in the public Android SDK.
 * Cloud transcription remains available, and these methods intentionally no-op
 * so existing callers can continue to compile without the native dependency.
 */
class SherpaOnnxTranscriber(@Suppress("UNUSED_PARAMETER") context: Context) {
    interface TranscriptListener {
        fun onPartialResult(text: String, language: String)
        fun onFinalResult(text: String, language: String)
    }

    private var listener: TranscriptListener? = null

    fun initialize() {
        Bridge.log("Local Sherpa-ONNX transcription is unavailable in this SDK build")
    }

    fun acceptAudio(@Suppress("UNUSED_PARAMETER") pcm16le: ByteArray) = Unit

    fun shutdown() = Unit

    fun restart() = initialize()

    fun setTranscriptListener(listener: TranscriptListener?) {
        this.listener = listener
    }

    fun isInitialized(): Boolean = false

    fun microphoneStateChanged(@Suppress("UNUSED_PARAMETER") state: Boolean) = Unit
}
`

const STUB_TTS_TOOLS = `package com.mentra.core.tts

import android.content.Context
import com.mentra.bluetoothsdk.Bridge

/**
 * Compatibility shell for the optional local TTS integration.
 *
 * Sherpa-ONNX is not bundled in the public Android SDK, so local synthesis is
 * unavailable. The methods remain available to preserve the native API shape.
 */
object TTSTools {
    fun setTtsModelDetails(
            @Suppress("UNUSED_PARAMETER") context: Context,
            @Suppress("UNUSED_PARAMETER") path: String,
            @Suppress("UNUSED_PARAMETER") languageCode: String,
    ) {
        Bridge.log("Local Sherpa-ONNX TTS is unavailable in this SDK build")
    }

    fun getTtsModelPath(@Suppress("UNUSED_PARAMETER") context: Context): String = ""

    fun getTtsModelLanguage(@Suppress("UNUSED_PARAMETER") context: Context): String = "en-US"

    fun checkTTSModelAvailable(@Suppress("UNUSED_PARAMETER") context: Context): Boolean = false

    fun validateTTSModel(@Suppress("UNUSED_PARAMETER") path: String): Boolean = false

    fun generateTtsAudio(
            @Suppress("UNUSED_PARAMETER") context: Context,
            @Suppress("UNUSED_PARAMETER") text: String,
            @Suppress("UNUSED_PARAMETER") modelPath: String,
            @Suppress("UNUSED_PARAMETER") outputPath: String,
            @Suppress("UNUSED_PARAMETER") speakerId: Int,
            @Suppress("UNUSED_PARAMETER") speed: Float,
    ): Boolean = false
}
`
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

/**
 * npm 0.1.19 still pulls the ~54MB Sherpa AAR. MentraOS source already ships
 * no-op stubs instead. Strip the Gradle dep + replace Kotlin sources so the
 * example builds without GitHub downloads. Survives `bun install` because we
 * re-apply after install.
 */
function stripSherpaFromInstalledSdk(sdkRoot) {
  const buildGradlePaths = [
    path.join(sdkRoot, "android/build.gradle"),
    path.join(sdkRoot, "android/bin/build.gradle"),
  ].filter((p) => fs.existsSync(p))

  let patchedGradle = false
  for (const buildGradlePath of buildGradlePaths) {
    let contents = fs.readFileSync(buildGradlePath, "utf8")
    if (!contents.includes("com.k2fsa.sherpa.onnx") && !contents.includes("sherpa-onnx")) {
      continue
    }

    contents = contents.replace(/^import java\.security\.MessageDigest\n/m, "")

    // Drop the configure-time download block through the sherpa-aware repositories.
    contents = contents.replace(
      /\/\/ Download Sherpa-ONNX[\s\S]*?repositories \{\n  maven \{ url = uri\(sherpaOnnxMavenRoot\) \}\n  maven \{ url 'https:\/\/jitpack\.io' \}\n\}/m,
      `// Local Sherpa-ONNX STT/TTS is intentionally not bundled in the public SDK.
repositories {
  maven { url 'https://jitpack.io' }
}`,
    )

    contents = contents.replace(
      /\n\s*\/\/ Sherpa-ONNX for local transcription\.[\s\S]*?dependencies\.add\(optionalMentraOsIntegrationDependency, "\$\{sherpaOnnxGroup\}:\$\{sherpaOnnxArtifact\}:\$\{sherpaOnnxVersion\}@aar"\)\n/,
      "\n",
    )

    // If a prior patch left an unused helper, drop it.
    contents = contents.replace(
      /\n\s*def optionalMentraOsIntegrationDependency = publicMavenSdk \? 'compileOnly' : 'implementation'\n/,
      "\n",
    )

    fs.writeFileSync(buildGradlePath, contents)
    patchedGradle = true
  }

  const mentraOsStt = mentraOsSdkSibling
    ? path.join(
        mentraOsSdkSibling,
        "android/src/main/java/com/mentra/bluetoothsdk/stt/SherpaOnnxTranscriber.kt",
      )
    : null
  const mentraOsTts = mentraOsSdkSibling
    ? path.join(mentraOsSdkSibling, "android/src/main/java/com/mentra/bluetoothsdk/tts/TTSTools.kt")
    : null
  const stubSources = [
    [
      path.join(sdkRoot, "android/src/main/java/com/mentra/bluetoothsdk/stt/SherpaOnnxTranscriber.kt"),
      mentraOsStt,
      STUB_SHERPA_TRANSCRIBER,
    ],
    [
      path.join(sdkRoot, "android/src/main/java/com/mentra/bluetoothsdk/tts/TTSTools.kt"),
      mentraOsTts,
      STUB_TTS_TOOLS,
    ],
    [
      path.join(
        sdkRoot,
        "android/bin/src/main/java/com/mentra/bluetoothsdk/stt/SherpaOnnxTranscriber.kt",
      ),
      mentraOsStt,
      STUB_SHERPA_TRANSCRIBER,
    ],
    [
      path.join(sdkRoot, "android/bin/src/main/java/com/mentra/bluetoothsdk/tts/TTSTools.kt"),
      mentraOsTts,
      STUB_TTS_TOOLS,
    ],
  ]

  let patchedSources = false
  for (const [dest, preferredSource, embeddedStub] of stubSources) {
    if (!fs.existsSync(path.dirname(dest))) {
      continue
    }
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : ""
    if (existing.includes("not bundled in the public Android SDK")) {
      continue
    }
    if (existing.includes("com.k2fsa.sherpa.onnx") || existing.length === 0 || fs.existsSync(dest)) {
      const body =
        preferredSource && fs.existsSync(preferredSource)
          ? fs.readFileSync(preferredSource, "utf8")
          : embeddedStub
      fs.writeFileSync(dest, body)
      patchedSources = true
    }
  }

  if (patchedGradle || patchedSources) {
    console.log(
      "Stripped Sherpa-ONNX from installed @mentra/bluetooth-sdk (public SDK uses no-op stubs).",
    )
  }
}

/**
 * When linking MentraOS bluetooth-sdk, Gradle must see android/libs/maven for
 * sherpa-onnx, and :lc3Lib/:silero must point at that same checkout. The RN
 * example's generated android/ tree is gitignored, so re-apply every run.
 */
function ensureMentraOsSdkGradleWiring(projectRoot, sdkRoot) {
  const buildGradlePath = path.join(projectRoot, "android/build.gradle")
  const settingsGradlePath = path.join(projectRoot, "android/settings.gradle")
  if (!fs.existsSync(buildGradlePath) || !fs.existsSync(settingsGradlePath)) {
    return
  }

  let buildGradle = fs.readFileSync(buildGradlePath, "utf8")
  if (!buildGradle.includes("android/libs/maven")) {
    const repoBlock = `allprojects {
  repositories {
    // MentraOS bluetooth-sdk stages sherpa-onnx under android/libs/maven (not on Maven Central).
    def mentraBluetoothSdkPackagePath = System.getenv("MENTRA_BLUETOOTH_SDK_PACKAGE_PATH")
    if (mentraBluetoothSdkPackagePath) {
      maven { url = uri(new File(mentraBluetoothSdkPackagePath, "android/libs/maven")) }
    } else {
      def npmSdk = new File(rootDir, "../node_modules/@mentra/bluetooth-sdk/android/libs/maven")
      if (npmSdk.exists()) {
        maven { url = uri(npmSdk) }
      }
    }
    google()
    mavenCentral()
    maven { url 'https://www.jitpack.io' }
  }
}`
    if (/allprojects\s*\{\s*repositories\s*\{[\s\S]*?\}\s*\}/.test(buildGradle)) {
      buildGradle = buildGradle.replace(
        /allprojects\s*\{\s*repositories\s*\{[\s\S]*?\}\s*\}/,
        repoBlock,
      )
    } else {
      buildGradle = `${buildGradle.trimEnd()}\n\n${repoBlock}\n`
    }
    fs.writeFileSync(buildGradlePath, buildGradle)
    console.log("Wired MentraOS sherpa-onnx local Maven repo into android/build.gradle")
  }

  const resolveSdkNode = `const fs=require('fs');const path=require('path');const appRoot=path.join(process.cwd(),'..');const fromEnv=process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH;if(fromEnv&&fs.existsSync(path.join(fromEnv,'android'))){process.stdout.write(fs.realpathSync(fromEnv));process.exit(0);}const local=path.join(appRoot,'modules/bluetooth-sdk');if(fs.existsSync(path.join(local,'android/silero'))){process.stdout.write(fs.realpathSync(local));process.exit(0);}process.stdout.write(path.dirname(require.resolve('@mentra/bluetooth-sdk/package.json')));`
  let settingsGradle = fs.readFileSync(settingsGradlePath, "utf8")
  const resolveMarker = "MENTRA_BLUETOOTH_SDK_PACKAGE_PATH"
  if (
    !settingsGradle.includes(resolveMarker) ||
    settingsGradle.includes("node_modules/@mentra/bluetooth-sdk\", 'android')")
  ) {
    settingsGradle = settingsGradle.replace(
      /def mentraBluetoothSdkRoot = new File\(\s*providers\.exec \{\s*workingDir\(rootDir\)\s*commandLine\(\s*"node",\s*"-e",\s*"[^"]*"\s*\)\s*\}\.standardOutput\.asText\.get\(\)\.trim\(\)\s*\)/s,
      `def mentraBluetoothSdkRoot = new File(
  providers.exec {
    workingDir(rootDir)
    commandLine(
      "node",
      "-e",
      "${resolveSdkNode.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
    )
  }.standardOutput.asText.get().trim()
)`,
    )
    settingsGradle = settingsGradle.replace(
      /if \(findProject\(':mentra-bluetooth-sdk'\) != null\) \{\s*project\(':mentra-bluetooth-sdk'\)\.projectDir = new File\([^)]+\)\s*\}/s,
      `if (findProject(':mentra-bluetooth-sdk') != null) {
  project(':mentra-bluetooth-sdk').projectDir = new File(mentraBluetoothSdkRoot, 'android')
}`,
    )
    fs.writeFileSync(settingsGradlePath, settingsGradle)
    console.log("Pointed android/settings.gradle SDK paths at MENTRA_BLUETOOTH_SDK_PACKAGE_PATH")
  }

  const sherpaAar = path.join(
    sdkRoot,
    "android/libs/maven/com/k2fsa/sherpa/onnx/sherpa-onnx/1.13.2/sherpa-onnx-1.13.2.aar",
  )
  if (!fs.existsSync(sherpaAar)) {
    console.warn(
      `Sherpa-ONNX AAR missing at ${sherpaAar}. MentraOS bluetooth-sdk configure will try to download it from GitHub.`,
    )
  } else {
    console.log(`Sherpa-ONNX local Maven artifact present: ${sherpaAar}`)
  }
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

applyFastGradleDefaults()
if (!localSdkOverride) {
  stripSherpaFromInstalledSdk(sdkRoot)
}
if (!fs.existsSync(path.join(projectRoot, "android/settings.gradle"))) {
  console.log("Generating the Android project...")
  run("bunx", ["expo", "prebuild", "--platform", "android"])
}
ensureMentraOsSdkGradleWiring(projectRoot, sdkRoot)

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
