import {execFileSync, spawnSync} from "node:child_process"
import {readFileSync} from "node:fs"
import path from "node:path"
import {
  appendXcodeEnvironment,
  assertBundleEnvironment,
  xcodeBuildSettings,
} from "../../scripts/release-bundle-config.mjs"

const signed = process.env.PR_IOS_SIGNED === "true"
const mobile = path.resolve("mobile")
const env = {...process.env, NODE_ENV: "production", SENTRY_DISABLE_AUTO_UPLOAD: "true"}
if (signed) {
  execFileSync("security", ["unlock-keychain", "-p", env.PR_IOS_KEYCHAIN_PASSWORD, env.PR_IOS_KEYCHAIN])
  // The old compile-only workflow inherited a sample version and no build
  // identity from .env.example. Published PR apps need the checkout's identity.
  Object.assign(env, {
    EXPO_PUBLIC_MENTRAOS_VERSION: JSON.parse(readFileSync("package.json", "utf8")).version,
    EXPO_PUBLIC_BUILD_BRANCH: env.GITHUB_HEAD_REF,
    EXPO_PUBLIC_BUILD_COMMIT: execFileSync("git", ["rev-parse", "--short", "HEAD"], {encoding: "utf8"}).trim(),
    EXPO_PUBLIC_BUILD_USER: env.GITHUB_ACTOR,
    EXPO_PUBLIC_BUILD_TIME: new Date().toISOString(),
  })
}
await appendXcodeEnvironment(path.join(mobile, "ios/.xcode.env.local"), env, process.execPath)
const args = [
  signed ? "archive" : "build",
  "-workspace",
  "Mentra.xcworkspace",
  "-scheme",
  "Mentra",
  "-configuration",
  "Release",
  "-destination",
  "generic/platform=iOS",
  "-derivedDataPath",
  "build-device",
]
// No -quiet: the workflow wraps this script with
// .github/scripts/ios-xcodebuild-attempt.sh, which keeps the complete log
// (CodeSign commands, script-phase output) in an artifact and filters the
// console. -quiet also hid the identity and keychain behind
// errSecInternalComponent on signing failures. The timing summary feeds the
// job summary's CompileC vs SwiftCompile breakdown.
args.push("-showBuildTimingSummary")
// Per-attempt result bundle for diagnosis; the wrapper removes any stale path
// first because xcodebuild refuses to overwrite one.
if (process.env.MENTRA_IOS_RESULT_BUNDLE) args.push("-resultBundlePath", process.env.MENTRA_IOS_RESULT_BUNDLE)
if (process.argv.includes("--serial")) args.push("-jobs", "1")
const words = (value) => (value ? value.split(/\s+/).filter(Boolean) : [])
// Compile-check-only build settings (no dSYM/debug info/index store) come
// from .github/scripts/ios-compile-check-settings.sh. They never apply to a
// signed archive: testers install that app and its crash logs need symbols.
if (!signed) args.push(...words(process.env.MENTRA_IOS_COMPILE_CHECK_SETTINGS_STR))
// PR-build experiments (scheduling flags, Swift compilation mode) from the
// same script apply to every pull_request build; the workflow leaves both
// variables empty for push builds. Flags go before the action's settings.
args.push(...words(process.env.MENTRA_IOS_XCODEBUILD_EXTRA_ARGS_STR))
args.push(...words(process.env.MENTRA_IOS_PR_BUILD_SETTINGS_STR))
if (signed) {
  args.push(
    "-archivePath",
    path.join(mobile, "build/pr-ios/Mentra.xcarchive"),
    `OTHER_CODE_SIGN_FLAGS=--keychain ${process.env.PR_IOS_KEYCHAIN}`,
  )
} else args.push("CODE_SIGN_IDENTITY=", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGNING_ALLOWED=NO")
args.push(...xcodeBuildSettings(env, process.execPath))
const result = spawnSync("xcodebuild", args, {cwd: path.join(mobile, "ios"), env, stdio: "inherit"})
if (result.error) throw result.error
if (signed && result.status !== 0) {
  // Public signing metadata only; never dump keychain contents or credentials.
  for (const args of [
    ["list-keychains", "-d", "user"],
    ["show-keychain-info", env.PR_IOS_KEYCHAIN],
    ["find-identity", "-v", "-p", "codesigning", env.PR_IOS_KEYCHAIN],
  ])
    spawnSync("security", args, {stdio: "inherit", timeout: 20_000})
}
if (signed && result.status === 0) {
  const bundle = readFileSync(
    path.join(mobile, "build/pr-ios/Mentra.xcarchive/Products/Applications/Mentra.app/main.jsbundle"),
  )
  assertBundleEnvironment(bundle, env, "iOS PR")
}
process.exit(result.status ?? 1)
