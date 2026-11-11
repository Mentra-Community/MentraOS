import {appendFileSync, readFileSync} from "node:fs"
import path from "node:path"
import {setTimeout as sleep} from "node:timers/promises"
import {fileURLToPath} from "node:url"

import {getBuildNumber} from "../../mobile/scripts/build-number.mjs"
import {readPublicIndex} from "./release-artifact-storage.mjs"
import {ANDROID_CODE_LEDGER, prAndroidVersionCode, reservedAndroidCodes} from "./resolve-android-version-code.mjs"

// Every reserved Android version code, from the ledger's public download index
// (no credentials). A PR build that cannot read it fails: its fallback, the
// family number, would not install over the betas testers have.
export async function readAndroidReservations({readIndex = readPublicIndex, attempts = 3, wait = sleep} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const {assets} = await readIndex(ANDROID_CODE_LEDGER.repository, ANDROID_CODE_LEDGER.tag)
      return reservedAndroidCodes(assets)
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(`Could not read the Android version code reservations: ${error.message}`)
      }
      console.error(`Reading the Android version code reservations failed (${error.message}); retrying`)
      await wait(5_000 * attempt)
    }
  }
}

// The build number a PR build pins. The Mentra App's Android build sits above
// every reserved code (prAndroidVersionCode); iOS and the Bluetooth example keep
// the family number.
export async function pinnedPrBuildNumber({
  platform,
  app = "mentra",
  familyNumber,
  readReservations = readAndroidReservations,
}) {
  if (platform !== "android" || app !== "mentra") return {buildNumber: familyNumber}
  const result = prAndroidVersionCode({familyNumber, reservations: await readReservations()})
  return {buildNumber: result.versionCode, androidReservedFloor: result.reservedFloor, source: result.source}
}

async function main() {
  // `android` from the Android workflows; the iOS workflows pass nothing.
  const platform = process.argv[2] ?? "ios"
  const familyNumber = getBuildNumber()
  const pinned = await pinnedPrBuildNumber({platform, app: process.env.MENTRA_PR_APP || "mentra", familyNumber})
  if (pinned.source === "reserved-floor") {
    console.log(
      `Android version code ${pinned.buildNumber}: one above the latest reserved code, above the family number ${familyNumber}`,
    )
  } else {
    console.log(`Build number ${pinned.buildNumber} (the family number)`)
  }
  // The same stable compilation environment and per-run packaging inputs on both
  // platforms. No branch/head/time is inlined into reusable JavaScript.
  const env = {
    MENTRAOS_PINNED_BUILD_NUMBER: String(pinned.buildNumber),
    // An earlier push's APK at or below this code is below a reserved beta
    // (pr-mobile-build-unchanged.mjs).
    ...(pinned.androidReservedFloor !== undefined
      ? {MENTRA_ANDROID_RESERVED_CODE_FLOOR: String(pinned.androidReservedFloor)}
      : {}),
    EXPO_PUBLIC_MENTRAOS_VERSION: JSON.parse(readFileSync("package.json", "utf8")).version,
    EXPO_PUBLIC_BUILD_BRANCH: "",
    EXPO_PUBLIC_BUILD_COMMIT: "",
    EXPO_PUBLIC_BUILD_USER: "",
    EXPO_PUBLIC_BUILD_TIME: "",
    EXPO_PUBLIC_ASG_OTA_VERSION_URL: "",
    NODE_ENV: "production",
  }
  appendFileSync(
    process.env.GITHUB_ENV,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
