import {execFileSync} from "node:child_process"
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {
  appendXcodeEnvironment,
  assertBundleEnvironment,
  xcodeBuildSettings,
} from "../../scripts/release-bundle-config.mjs"
import {prApp} from "../../../.github/scripts/pr-mobile-build.mjs"
import {compilationCacheSettings, runXcode} from "./xcode-attempt.mjs"

// The app is MENTRA_PR_APP's (PR_APPS in pr-mobile-build.mjs), compiled from its
// root; the signing setup and the archive stay in mobile/build/pr-ios.
const app = prApp(process.env.MENTRA_PR_APP || "mentra")
const project = app.xcodeProject
const signed = process.env.PR_IOS_SIGNED === "true"
const mobile = path.resolve("mobile")
const ios = path.resolve(app.root, "ios")
const output = path.join(mobile, "build/pr-ios")
const archive = path.join(output, `${project}.xcarchive`)
const env = {...process.env, NODE_ENV: "production", SENTRY_DISABLE_AUTO_UPLOAD: "true"}
await appendXcodeEnvironment(path.join(ios, ".xcode.env.local"), env, process.execPath)
const target = ["-workspace", `${project}.xcworkspace`, "-scheme", project, "-configuration", "Release"]
const args = [signed ? "archive" : "build", ...target, "-destination", "generic/platform=iOS"]
args.push("-derivedDataPath", "build-device")
// The workflow wrapper preserves the complete log and filters console output.
// Keep timing rows for both signed archives and unsigned compile checks.
args.push("-showBuildTimingSummary")
if (process.argv.includes("--serial")) args.push("-jobs", "1")
args.push(...compilationCacheSettings)
// A signed build archives unsigned, outside the Mac signing lock
// (keychain-search.py), so two signed jobs on one Mac compile at once; the
// workflow's export step signs it as Xcode would have (artifacts.py
// sign-archive), under the lock.
// Xcode refuses an ad hoc signed iOS archive, and a second, signed archive
// compiles everything again.
if (signed) args.push("-archivePath", archive, "CODE_SIGNING_ALLOWED=NO")
else args.push("CODE_SIGN_IDENTITY=", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGNING_ALLOWED=NO")
args.push(...xcodeBuildSettings(env, process.execPath))
const result = await runXcode(args, {cwd: ios, env})
if (result.signal) console.error(`xcodebuild terminated by ${result.signal}`)
if (signed && result.status === 0) {
  // For sign-archive: the app target's entitlements file and the variables it uses.
  const query = ["-showBuildSettings", "-json", ...target, "-destination", "generic/platform=iOS"]
  query.push(...xcodeBuildSettings(env, process.execPath))
  const settings = execFileSync("xcodebuild", query, {cwd: ios, env, maxBuffer: 1024 ** 3})
  writeFileSync(path.join(output, "build-settings.json"), settings)
}
// The Mentra App's backend configuration; the example app has none.
if (signed && result.status === 0 && app.root === "mobile") {
  const bundle = readFileSync(path.join(archive, `Products/Applications/${project}.app/main.jsbundle`))
  assertBundleEnvironment(bundle, env, "iOS PR")
}
process.exit(result.status ?? 1)
