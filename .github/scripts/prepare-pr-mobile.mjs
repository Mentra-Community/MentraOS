import {appendFileSync, readFileSync} from "node:fs"
import path from "node:path"
import {setTimeout as sleep} from "node:timers/promises"
import {fileURLToPath} from "node:url"

import {familyBaseVersion} from "../../mobile/scripts/build-number.mjs"
import {prFamilyBuildNumber} from "./allocate-family-build-sequence.mjs"
import {readPublicIndex} from "./release-artifact-storage.mjs"
import {ANDROID_CODE_LEDGER, prAndroidVersionCode, reservedAndroidCodes} from "./resolve-android-version-code.mjs"

// The assets of one of the ledger's releases, from its public download index (no
// credentials). A PR build that cannot read it fails: without it, its number
// would not sit between the releases testers have.
async function readLedgerAssets(tag, what, {readIndex = readPublicIndex, attempts = 3, wait = sleep} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return (await readIndex(ANDROID_CODE_LEDGER.repository, tag)).assets
    } catch (error) {
      if (attempt >= attempts) throw new Error(`Could not read ${what}: ${error.message}`)
      console.error(`Reading ${what} failed (${error.message}); retrying`)
      await wait(5_000 * attempt)
    }
  }
}

// Every reserved Android version code.
export async function readAndroidReservations(options) {
  return reservedAndroidCodes(
    await readLedgerAssets(ANDROID_CODE_LEDGER.tag, "the Android version code reservations", options),
  )
}

// One above the family's latest release number, recorded as a marker in the
// family's container or as an ASG pair in the shared ASG release.
export async function readPrFamilyBuildNumber(baseVersion, options) {
  const what = `the ${baseVersion} release numbers`
  const assets = [
    ...(await readLedgerAssets(`mentra-builds-v${baseVersion}`, what, options)),
    ...(await readLedgerAssets(ANDROID_CODE_LEDGER.tag, what, options)),
  ]
  return prFamilyBuildNumber({assets, baseVersion})
}

// The build number a PR build pins. The Mentra App's Android build sits above
// every reserved code (prAndroidVersionCode); iOS, the Bluetooth example and the
// dev app, which has no floor on Play, take the family number, one above the
// family's latest release.
export async function pinnedPrBuildNumber({
  platform,
  app = "mentra",
  track = "staging",
  familyNumber,
  readReservations = readAndroidReservations,
}) {
  if (platform !== "android" || app !== "mentra" || track === "dev") return {buildNumber: familyNumber}
  const result = prAndroidVersionCode({familyNumber, reservations: await readReservations()})
  return {buildNumber: result.versionCode, source: result.source}
}

async function main() {
  // `android` from the Android workflows; the iOS workflows pass nothing.
  const platform = process.argv[2] ?? "ios"
  const familyNumber = await readPrFamilyBuildNumber(familyBaseVersion())
  const pinned = await pinnedPrBuildNumber({
    platform,
    app: process.env.MENTRA_PR_APP || "mentra",
    track: process.env.MENTRA_APP_TRACK,
    familyNumber,
  })
  if (pinned.source === "reserved-floor") {
    console.log(
      `Android version code ${pinned.buildNumber}: one above the latest reserved code, above the family number ${familyNumber}`,
    )
  } else {
    console.log(`Build number ${pinned.buildNumber}: one above the family's latest release`)
  }
  // The same stable compilation environment and per-run packaging inputs on both
  // platforms. No branch/head/time is inlined into reusable JavaScript.
  const env = {
    // An earlier push's build is reused only at this number
    // (pr-mobile-build-unchanged.mjs).
    MENTRAOS_PINNED_BUILD_NUMBER: String(pinned.buildNumber),
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
