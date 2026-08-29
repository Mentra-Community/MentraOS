#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

function versionCodes(release) {
  if (!Array.isArray(release?.versionCodes)) throw new Error("Google Play release has no version-code list")
  return release.versionCodes.map((value) => {
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Google Play release has an invalid version code")
    return number
  })
}

function exactProductionRelease(inventory, expectedVersionCode) {
  if (!Number.isSafeInteger(expectedVersionCode) || expectedVersionCode < 1) {
    throw new Error("expected Google Play version code must be a positive safe integer")
  }
  const releases = inventory?.releases?.production
  if (!Array.isArray(releases)) throw new Error("Google Play inventory has no production release details")
  const matches = releases.filter((release) => versionCodes(release).includes(expectedVersionCode))
  if (matches.length !== 1) {
    throw new Error(`expected exactly one Google Play production release for version ${expectedVersionCode}`)
  }
  return matches[0]
}

function releaseResult(inventory, expectedVersionCode, release, state) {
  return {
    schemaVersion: 1,
    kind: "google-play-production-release-state",
    packageName: inventory.packageName,
    versionCode: expectedVersionCode,
    requiredState: state,
    status: release.status,
    userFraction: release.userFraction ?? null,
    releaseName: release.name ?? null,
  }
}

export function validateGooglePlayDraft(inventory, expectedVersionCode) {
  const release = exactProductionRelease(inventory, expectedVersionCode)
  if (release.status !== "draft" || (release.userFraction !== null && release.userFraction !== undefined)) {
    throw new Error(`Google Play release is not an unreleased draft: ${release.status || "missing status"}`)
  }
  return releaseResult(inventory, expectedVersionCode, release, "draft")
}

export function validateGooglePlayRollout(inventory, expectedVersionCode) {
  const release = exactProductionRelease(inventory, expectedVersionCode)
  if (release.status === "inProgress") {
    if (typeof release.userFraction !== "number" || release.userFraction <= 0 || release.userFraction >= 1) {
      throw new Error("in-progress Google Play release has no valid rollout fraction")
    }
  } else if (release.status === "completed") {
    if (release.userFraction !== null && release.userFraction !== undefined) {
      throw new Error("completed Google Play release unexpectedly has a rollout fraction")
    }
  } else {
    throw new Error(`Google Play release is not public: ${release.status || "missing status"}`)
  }
  return releaseResult(inventory, expectedVersionCode, release, "public")
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
  const inventory = JSON.parse(readFileSync(path.resolve(args.inventory), "utf8"))
  const expectedVersionCode = Number(args["version-code"])
  const validators = {draft: validateGooglePlayDraft, public: validateGooglePlayRollout}
  const validate = validators[args["required-state"]]
  if (!validate) throw new Error("--required-state must be draft or public")
  const result = validate(inventory, expectedVersionCode)
  writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
