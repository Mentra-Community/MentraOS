#!/usr/bin/env bun
import "./configure-zx-shell.mjs"
import {createHash} from "node:crypto"
import {runPodInstallIfNeeded} from "./cocoapods-install.mjs"
import {setBuildEnv} from "./set-build-env.mjs"

const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log(`Usage: bun ios:mac [--debug] [--build-only] [--e2e-host-network]

Build the iOS app for this Apple Silicon Mac, then launch it in the background.
Release is the default: JavaScript is bundled, so Metro is unnecessary.
--debug uses Metro; start bun start in a separate terminal.
--build-only leaves the running app untouched.
--e2e-host-network compiles the test-only Mac network lease adapter. Runs using
  this adapter test real media but do not qualify native iPhone Wi-Fi association.
Set EXPO_PUBLIC_ASG_OTA_VERSION_URL to an explicitly selected public manifest
  to enable glasses OTA. Without a manifest, local builds keep OTA disabled.
Uses the existing Xcode account, development signing, and mobile/.env.
Does not archive, export an IPA, or upload to TestFlight.`)
  process.exit(0)
}
for (const arg of args) {
  if (!["--debug", "--build-only", "--e2e-host-network"].includes(arg)) throw new Error(`Unknown argument: ${arg}`)
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("ios:mac requires an Apple Silicon Mac.")
}

const configuration = args.includes("--debug") ? "Debug" : "Release"
const e2eHostNetwork = args.includes("--e2e-host-network")
const projectRoot = process.cwd()
const derivedData = path.resolve("build/ios-mac")
if (e2eHostNetwork) {
  await fs.access("modules/glasses-media/ios/CoreKit/Sources/GlassesMediaCore/MacE2EHotspotLease.swift")
}
await setBuildEnv()
// A copied .env may still name an old release. The repository root owns the
// local version, including the value Metro embeds in the Settings screen.
const localVersion = JSON.parse(await fs.readFile("../package.json", "utf8")).version
if (!/^\d+\.\d+\.\d+$/.test(localVersion)) throw new Error("Invalid canonical local version")
process.env.EXPO_PUBLIC_MENTRAOS_VERSION = localVersion
// Local builds keep debug symbols local, as the PR compile check does.
process.env.SENTRY_DISABLE_AUTO_UPLOAD = "true"
// The shared helper installs Pods with the repository's download/cache policy.
await $({stdio: "inherit"})`bun expo prebuild --platform ios --no-install`
await runPodInstallIfNeeded({
  cwd: "ios",
  projectRoot,
  force: process.env.MENTRA_POD_INSTALL === "force",
})
const localEnv = (await fs.readFile(".env", "utf8")).replace(/^EXPO_PUBLIC_MENTRAOS_VERSION=.*\n?/m, "")
await fs.writeFile("ios/.xcode.env.local", `${localEnv}\nexport EXPO_PUBLIC_MENTRAOS_VERSION=${localVersion}\n`)
await fs.chmod("ios/.xcode.env.local", 0o600)

const workspaces = await glob("ios/*.xcworkspace", {onlyDirectories: true})
if (workspaces.length !== 1) throw new Error(`Expected one iOS workspace, found ${workspaces.length}`)
const workspace = workspaces[0]
const scheme = path.basename(workspace, ".xcworkspace")
const signing = await $({quiet: true})`security find-identity -v -p codesigning`
if (!/"Apple Development:/.test(signing.stdout)) {
  throw new Error("No valid Apple Development identity. Configure Xcode → Settings → Accounts → Manage Certificates.")
}

// Select the iOS-on-Mac destination, not Catalyst, a simulator, or plain macOS.
// Xcode prints a comma inside the variant, so select its id and architecture.
const destinations =
  await $`xcodebuild -workspace ${workspace} -scheme ${scheme} -showdestinations -derivedDataPath ${derivedData}`
const mac = destinations.stdout
  .split("\n")
  .filter((line) => /platform:macOS/.test(line) && /variant:Designed for/.test(line))
if (mac.length !== 1) throw new Error(`Expected one Designed for iPhone/iPad destination, found ${mac.length}`)
const id = /\bid:([^,}]+)/.exec(mac[0])?.[1].trim()
const arch = /\barch:([^,}]+)/.exec(mac[0])?.[1].trim()
if (!id || arch !== "arm64") throw new Error(`Unsupported iOS-on-Mac destination: ${mac[0]}`)
const destination = `platform=macOS,arch=${arch},id=${id}`
const podProperties = JSON.parse(await fs.readFile("ios/Podfile.properties.json", "utf8"))
const deploymentTarget = podProperties["ios.deploymentTarget"]
if (!/^\d+\.\d+$/.test(deploymentTarget ?? "")) throw new Error("Missing generated iOS deployment target")
const common = [
  "-workspace",
  workspace,
  "-scheme",
  scheme,
  "-configuration",
  configuration,
  "-destination",
  destination,
  "-derivedDataPath",
  derivedData,
  "-allowProvisioningUpdates",
  "-allowProvisioningDeviceRegistration",
  // Xcode 27 treats old Pod deployment targets as errors for iOS-on-Mac.
  // Compile all targets with the app's configured minimum, preserving its support floor.
  `IPHONEOS_DEPLOYMENT_TARGET=${deploymentTarget}`,
  ...(e2eHostNetwork ? ["SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) MENTRA_E2E"] : []),
]

console.log(`Building ${configuration} for this Mac (${id}).`)
const sourceBefore = {
  commit: (await $({quiet: true})`git rev-parse HEAD`).stdout.trim(),
  status: (await $({quiet: true})`git status --porcelain`).stdout.trim(),
  diff: (await $({quiet: true})`git -C .. diff HEAD -- mobile`).stdout,
  mobileStatus: (await $({quiet: true})`git -C .. status --porcelain -- mobile`).stdout,
}
await $({stdio: "inherit"})`xcodebuild -quiet ${common} build`
if (
  sourceBefore.commit !== (await $({quiet: true})`git rev-parse HEAD`).stdout.trim() ||
  sourceBefore.diff !== (await $({quiet: true})`git -C .. diff HEAD -- mobile`).stdout ||
  sourceBefore.mobileStatus !== (await $({quiet: true})`git -C .. status --porcelain -- mobile`).stdout
)
  throw new Error("Mobile source changed during the build; rerun before using the product as test evidence")
// Resolve the product from the exact target settings, never a stale glob/mtime.
const settingsResult = await $({quiet: true})`xcodebuild ${common} -showBuildSettings -json`
const settings = JSON.parse(settingsResult.stdout)
  .map((entry) => entry.buildSettings)
  .filter((entry) => entry.PRODUCT_TYPE === "com.apple.product-type.application")
if (settings.length !== 1) throw new Error(`Expected one application target, found ${settings.length}`)
const app = path.join(settings[0].TARGET_BUILD_DIR, settings[0].FULL_PRODUCT_NAME)
await fs.access(app)
const hash = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex")
const manifest = {
  schemaVersion: 1,
  builtAt: new Date().toISOString(),
  sourceCommit: sourceBefore.commit,
  sourceStatus: sourceBefore.status,
  sourceDiffSha256: createHash("sha256").update(sourceBefore.diff).digest("hex"),
  configuration,
  networkAdapter: e2eHostNetwork ? "mac-host-verified-test-only" : "native",
  otaManifestUrl: process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL?.trim() || null,
  destination,
  app,
  bundleId: settings[0].PRODUCT_BUNDLE_IDENTIFIER,
  executableSha256: await hash(path.join(settings[0].TARGET_BUILD_DIR, settings[0].EXECUTABLE_PATH)),
  javascriptSha256: configuration === "Release" ? await hash(path.join(app, "main.jsbundle")) : null,
}
if (manifest.otaManifestUrl && configuration === "Release") {
  const bundle = await fs.readFile(path.join(app, "main.jsbundle"))
  if (!bundle.includes(Buffer.from(manifest.otaManifestUrl))) {
    throw new Error("Selected OTA manifest URL is absent from the bundled JavaScript")
  }
}
// iOS-on-Mac launches require an outer app wrapper. Keep signed contents intact
// and use immutable per-build paths so compiling never overwrites a running app.
const wrapper = path.join(
  derivedData,
  "Applications",
  `${manifest.executableSha256.slice(0, 12)}-${manifest.javascriptSha256?.slice(0, 12) ?? "debug"}`,
  `${scheme}.app`,
)
if (!(await fs.pathExists(wrapper))) {
  await fs.ensureDir(path.join(wrapper, "Wrapper"))
  await $`cp -cR ${app} ${path.join(wrapper, "Wrapper", path.basename(app))}`
  await fs.symlink(`Wrapper/${path.basename(app)}`, path.join(wrapper, "WrappedBundle"))
}
manifest.launchPath = wrapper
await fs.writeFile(path.join(derivedData, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(`Built app: ${app}\nBuild evidence: ${path.join(derivedData, "build-manifest.json")}`)
if (!args.includes("--build-only")) {
  const launcher = path.join(derivedData, "launch-ios-on-mac")
  await $`xcrun swiftc -parse-as-library -O scripts/launch-ios-on-mac.swift -o ${launcher}`
  await $({stdio: "inherit"})`${launcher} ${wrapper}`
}
