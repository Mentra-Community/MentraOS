import {execFileSync, spawnSync} from "node:child_process"
import {appendFileSync, readFileSync} from "node:fs"
import path from "node:path"
import {
  appendXcodeEnvironment,
  assertBundleEnvironment,
  xcodeBuildSettings,
} from "../../scripts/release-bundle-config.mjs"
import {runXcode, signingOnlyFailure} from "./xcode-attempt.mjs"

const signed = process.env.PR_IOS_SIGNED === "true"
const mobile = path.resolve("mobile")
const env = {...process.env, NODE_ENV: "production", SENTRY_DISABLE_AUTO_UPLOAD: "true"}
if (signed) {
  execFileSync("security", ["unlock-keychain", "-p", env.PR_IOS_KEYCHAIN_PASSWORD, env.PR_IOS_KEYCHAIN])
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
// Signed archives need the full CodeSign command in CI logs when macOS rejects
// a framework. -quiet hid the identity and keychain behind errSecInternalComponent.
if (!signed) args.unshift("-quiet")
if (process.argv.includes("--serial")) args.push("-jobs", "1")
if (signed) {
  args.push(
    "-archivePath",
    path.join(mobile, "build/pr-ios/Mentra.xcarchive"),
    `OTHER_CODE_SIGN_FLAGS=--keychain ${process.env.PR_IOS_KEYCHAIN}`,
  )
} else args.push("CODE_SIGN_IDENTITY=", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGNING_ALLOWED=NO")
args.push(...xcodeBuildSettings(env, process.execPath))
let result = await runXcode(args, {cwd: path.join(mobile, "ios"), env})
if (signed && signingOnlyFailure(result)) {
  console.log("Signing failed after compilation. Unlocking the job keychain and retrying with existing build outputs.")
  execFileSync("security", ["unlock-keychain", "-p", env.PR_IOS_KEYCHAIN_PASSWORD, env.PR_IOS_KEYCHAIN])
  result = await runXcode(args, {cwd: path.join(mobile, "ios"), env})
}
if (signed && signingOnlyFailure(result) && env.GITHUB_OUTPUT) {
  appendFileSync(env.GITHUB_OUTPUT, "failure_kind=signing\n")
  console.error("Signing still failed; preserving compilation outputs instead of deleting caches and recompiling.")
}
if (result.signal) console.error(`xcodebuild terminated by ${result.signal}`)
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
