#!/usr/bin/env node
// The Android version code a coordinated build carries on Google Play.
//
// Play refuses a release on a track whose served release has a higher version
// code, and the family formula sits below the codes the `beta` and `internal`
// tracks served before the formula existed (310000212 and 900000002; see
// notes/superpowers/specs/2026-09-14-family-build-numbers.md). Until a family
// passes those floors, a build for a testing track takes a code two above both
// the track's floor and every code already reserved in the release container,
// leaving the code in between to pull-request builds (prAndroidVersionCode
// below); iOS and the ASG client keep the family number. Production borrows
// like a beta, two above the beta it promotes, so it installs over that beta.
// Internal App Sharing has no floor.
//
// A reservation is a marker `mentra-android-version-code-<code>-<owner>.json`
// published to the release container before the build, so a run that stops
// after building keeps its code and no later run takes it; a retry of the same
// owner finds its own marker and reuses the code.
import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {ANDROID_MAX_VERSION_CODE} from "./release-family.mjs"

// Where every Android reservation marker lives: the shared ASG release of the
// MentraOS ledger, whose public download index anyone can read.
export const ANDROID_CODE_LEDGER = {repository: "Mentra-Community/MentraOS", tag: "mentra-coordinated-asg"}
// The codes a borrowed testing-track code skips above the floor: one, the
// code a pull-request build built after the latest reservation takes.
const PR_BUILD_SLOT = 1

const FAMILY_NUMBER_TRACKS = new Set(["internal-app-sharing"])
const MARKER_PATTERN = /^mentra-android-version-code-(\d+)-([a-z0-9][a-z0-9-]{0,120})\.json$/
const OWNER_PATTERN = /^[a-z0-9][a-z0-9-]{0,120}$/

export function androidCodeMarkerName(code, owner) {
  return `mentra-android-version-code-${code}-${requireOwner(owner)}.json`
}

export function requireOwner(owner) {
  if (!OWNER_PATTERN.test(owner || "")) throw new Error(`Invalid Android code owner ${JSON.stringify(owner)}`)
  return owner
}

export function reservedAndroidCodes(assets) {
  if (!Array.isArray(assets)) throw new Error("GitHub release assets must be an array")
  return assets.flatMap((asset) => {
    const match = MARKER_PATTERN.exec(asset?.name ?? "")
    return match ? [{code: Number(match[1]), owner: match[2]}] : []
  })
}

export function resolveAndroidVersionCode({
  planBuildNumber,
  track,
  trackCodes = [],
  usedCodes = [],
  reservations = [],
  owner = null,
}) {
  if (!Number.isSafeInteger(planBuildNumber) || planBuildNumber < 1) {
    throw new Error(`Invalid plan build number ${JSON.stringify(planBuildNumber)}`)
  }
  if (typeof track !== "string" || track.length === 0) throw new Error("A Google Play track is required")
  const codes = trackCodes.map((code) => Number(code))
  if (codes.some((code) => !Number.isSafeInteger(code) || code < 1)) {
    throw new Error(`Track ${track} reports an invalid version code`)
  }
  const used = new Set(usedCodes.map((code) => Number(code)))
  if ([...used].some((code) => !Number.isSafeInteger(code) || code < 1)) {
    throw new Error("Google Play reports an invalid used version code")
  }
  if (owner !== null) requireOwner(owner)
  const owned = reservations.filter((reservation) => reservation.owner === owner)
  if (owned.length > 1) throw new Error(`${owner} reserved more than one Android version code`)
  if (owned.length === 1) return {versionCode: owned[0].code, source: "reservation", reused: true}
  if (FAMILY_NUMBER_TRACKS.has(track)) return {versionCode: planBuildNumber, source: "family", reused: false}
  const floor = Math.max(0, ...codes, ...reservations.map((reservation) => reservation.code))
  if (floor < planBuildNumber) return {versionCode: planBuildNumber, source: "family", reused: false}
  // Skip the code right above the floor: pull-request builds made since the
  // latest reservation carry it (prAndroidVersionCode), so this build is
  // strictly above them and installs over them, by sideload or from Play.
  // Play also refuses every code it has ever accepted, served or not (the
  // 3.1.0 betas left 310000213..227 behind the served 310000212).
  let versionCode = floor + PR_BUILD_SLOT + 1
  while (used.has(versionCode)) versionCode += 1
  return {versionCode, source: "track-floor", floor, reused: false}
}

// The Android version code of a pull-request build of the Mentra App: its
// family number (one above the family's latest release, prFamilyBuildNumber),
// or one above the latest reserved code when that is higher. While betas borrow codes above a Play track's floor
// (310,000,xxx through the 3.9 families), the latter wins, so a PR build
// installs over every beta and dev build already out, and the next beta,
// which skips that one code, installs over the PR build. PR builds made between
// the same two betas share a code, and Android installs an equal code over
// itself.
export function prAndroidVersionCode({familyNumber, reservations = []}) {
  if (!Number.isSafeInteger(familyNumber) || familyNumber < 1) {
    throw new Error(`Invalid family build number ${JSON.stringify(familyNumber)}`)
  }
  const codes = reservations.map((reservation) => reservation.code)
  if (codes.some((code) => !Number.isSafeInteger(code) || code < 1)) {
    throw new Error("A reserved Android version code is invalid")
  }
  const reservedFloor = Math.max(0, ...codes)
  const versionCode = Math.max(familyNumber, reservedFloor + PR_BUILD_SLOT)
  if (versionCode > ANDROID_MAX_VERSION_CODE) {
    throw new Error(`Android version code ${versionCode} is above Android's limit`)
  }
  return {versionCode, reservedFloor, source: versionCode === familyNumber ? "family" : "reserved-floor"}
}

export function androidCodeMarker({code, owner, planBuildNumber, track}) {
  return {
    schemaVersion: 1,
    kind: "mentra-android-version-code",
    versionCode: code,
    owner: requireOwner(owner),
    planBuildNumber,
    track,
  }
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error("Expected --name value pairs")
    values[args[index].slice(2)] = args[index + 1]
  }
  return values
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const plan = JSON.parse(readFileSync(path.resolve(args.plan), "utf8"))
  const trackCodes = args.codes ? JSON.parse(readFileSync(path.resolve(args.codes), "utf8")) : []
  const usedCodes = args.used ? JSON.parse(readFileSync(path.resolve(args.used), "utf8")) : []
  const reservations = args.assets
    ? reservedAndroidCodes(JSON.parse(readFileSync(path.resolve(args.assets), "utf8")))
    : []
  const result = resolveAndroidVersionCode({
    planBuildNumber: plan.native.buildNumber,
    track: args.track,
    trackCodes,
    usedCodes,
    reservations,
    owner: args.owner ?? null,
  })
  writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`)
  if (args.owner && args["marker-dir"] && !result.reused) {
    mkdirSync(path.resolve(args["marker-dir"]), {recursive: true})
    const marker = androidCodeMarker({
      code: result.versionCode,
      owner: args.owner,
      planBuildNumber: plan.native.buildNumber,
      track: args.track,
    })
    writeFileSync(
      path.join(path.resolve(args["marker-dir"]), androidCodeMarkerName(result.versionCode, args.owner)),
      `${JSON.stringify(marker, null, 2)}\n`,
    )
  }
  console.log(
    result.source === "reservation"
      ? `Android version code ${result.versionCode} (reserved earlier by ${args.owner})`
      : result.source === "family"
        ? `Android version code ${result.versionCode} (the family build number)`
        : `Android version code ${result.versionCode} (track ${args.track} or a reservation reaches ${result.floor}, above the family build number ${plan.native.buildNumber})`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
