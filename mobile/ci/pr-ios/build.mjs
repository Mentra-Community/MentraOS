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
  "-quiet",
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
if (process.argv.includes("--serial")) args.push("-jobs", "1")
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
if (signed && result.status === 0) {
  const bundle = readFileSync(
    path.join(mobile, "build/pr-ios/Mentra.xcarchive/Products/Applications/Mentra.app/main.jsbundle"),
  )
  assertBundleEnvironment(bundle, env, "iOS PR")
}
process.exit(result.status ?? 1)
