#!/usr/bin/env zx
// Build iOS archive with MENTRAOS_BUILD_NAME=Mentra-Stable so it installs alongside
// the regular Mentra build (bundle: com.mentra.mentra.stable, label: "stable").

process.env.MENTRAOS_BUILD_NAME = "Mentra Stable"

import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

const now = new Date()
const date = now.toLocaleDateString("en-US", {month: "2-digit", day: "2-digit", year: "2-digit"})
const time = now.toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit", hour12: true})
const archiveName = `Mentra-Stable-${date.replace(/\//g, "-")}, ${time}.xcarchive`

const archiveDate = now.toISOString().split("T")[0]
const archivePath = `${os.homedir()}/Library/Developer/Xcode/Archives/${archiveDate}/${archiveName}`

console.log(chalk.blue(`Building stable archive: ${archiveName}`))
console.log(chalk.blue(`MENTRAOS_BUILD_NAME=stable (bundle: com.mentra.mentra.stable)`))

await $({stdio: "inherit"})`bun expo prebuild --platform ios`

await $({stdio: "inherit"})`cp .env ios/.xcode.env.local`

await $({
  stdio: "inherit",
  env: process.env,
})`xcodebuild archive \
  -workspace ios/Mentra.xcworkspace \
  -scheme Mentra \
  -configuration Release \
  -destination generic/platform=iOS \
  -archivePath ${archivePath}`

console.log(chalk.green("✓ Stable archive created!"))
console.log(chalk.blue("Open: Xcode > Window > Organizer"))
console.log(chalk.blue("Then: Distribute App > Debugging > Install on device"))
