#!/usr/bin/env zx
import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

// Build iOS archive

const now = new Date()
const date = now.toLocaleDateString("en-US", {month: "2-digit", day: "2-digit", year: "2-digit"})
const time = now.toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit", hour12: true})
const archiveName = `MentraOS ${date.replace(/\//g, "-")}, ${time}.xcarchive`

const archiveDate = now.toISOString().split("T")[0]
const archivePath = `${os.homedir()}/Library/Developer/Xcode/Archives/${archiveDate}/${archiveName}`

console.log(chalk.blue(`Building archive: ${archiveName}`))

// prebuild ios:
await $({stdio: "inherit"})`bun expo prebuild --platform ios`

// copy .env to ios/.xcode.env.local:
await $({stdio: "inherit"})`cp .env ios/.xcode.env.local`

await $({
  stdio: "inherit",
  env: process.env,
})`xcodebuild archive \
  -workspace ios/MentraOS.xcworkspace \
  -scheme MentraOS \
  -configuration Release \
  -destination generic/platform=iOS \
  -archivePath ${archivePath}`

// -arch arm64 \

console.log(chalk.green("✓ Archive created!"))
console.log(chalk.blue("Open: Xcode > Window > Organizer"))
