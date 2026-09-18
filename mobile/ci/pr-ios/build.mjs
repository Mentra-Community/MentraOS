import {spawnSync} from "node:child_process"
import path from "node:path"
import {appendXcodeEnvironment, xcodeBuildSettings} from "../../scripts/release-bundle-config.mjs"

const signed = process.env.PR_IOS_SIGNED === "true"
const mobile = path.resolve("mobile")
const env = {...process.env, NODE_ENV: "production", SENTRY_DISABLE_AUTO_UPLOAD: "true"}
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
process.exit(result.status ?? 1)
