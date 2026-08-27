#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {serializeReleaseRecord} from "./release-family.mjs"

const SHA_PATTERN = /^[0-9a-f]{40}$/
const URL_PATTERN = /^https:\/\//

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`)
  return value
}

export function createExampleTestflightRecord({
  plan,
  starterKit,
  appId,
  bundleId,
  buildId,
  groupId,
  groupName,
  uploadStatus,
  provenanceUrl,
  ipa,
}) {
  if (
    !plan?.releaseSetId ||
    !["dev", "beta"].includes(plan.channel) ||
    plan.native?.marketingVersion !== plan.familyBaseVersion ||
    !Number.isSafeInteger(plan.native?.buildNumber)
  ) {
    throw new Error("A valid dev or beta release plan is required")
  }
  if (
    starterKit?.releaseSetId !== plan.releaseSetId ||
    starterKit.releaseIdentity !== plan.releaseIdentity ||
    starterKit.mentraos?.sourceCommit !== plan.sourceCommit ||
    !SHA_PATTERN.test(starterKit.starterKit?.releaseCommit || "")
  ) {
    throw new Error("Starter Kit result does not match the release plan")
  }
  const expectedGroup = plan.channel === "dev" ? "Mentra Dev" : "Mentra Staging"
  if (groupName !== expectedGroup) throw new Error(`TestFlight group must be ${expectedGroup}`)
  if (!["published", "reused"].includes(uploadStatus)) throw new Error("Invalid TestFlight upload status")
  if (!URL_PATTERN.test(provenanceUrl || "")) throw new Error("TestFlight provenance URL must use HTTPS")

  const record = {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    channel: plan.channel,
    mentraosSourceCommit: plan.sourceCommit,
    starterKitReleaseCommit: starterKit.starterKit.releaseCommit,
    app: {
      id: requiredString(appId, "App Store Connect app ID"),
      bundleId: requiredString(bundleId, "bundle ID"),
    },
    version: {
      marketingVersion: plan.native.marketingVersion,
      buildNumber: plan.native.buildNumber,
    },
    build: {
      id: requiredString(buildId, "App Store Connect build ID"),
      processingState: "VALID",
      uploadStatus,
    },
    group: {
      id: requiredString(groupId, "TestFlight group ID"),
      name: groupName,
    },
    provenanceUrl,
  }
  if (ipa) {
    const bytes = readFileSync(ipa)
    record.ipa = {
      size: statSync(ipa).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  }
  return record
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const record = createExampleTestflightRecord({
    plan: JSON.parse(readFileSync(path.resolve(args.plan), "utf8")),
    starterKit: JSON.parse(readFileSync(path.resolve(args["starter-kit"]), "utf8")),
    appId: args["app-id"],
    bundleId: args["bundle-id"],
    buildId: args["build-id"],
    groupId: args["group-id"],
    groupName: args["group-name"],
    uploadStatus: args["upload-status"],
    provenanceUrl: args["provenance-url"],
    ipa: args.ipa ? path.resolve(args.ipa) : undefined,
  })
  writeFileSync(path.resolve(args.output), serializeReleaseRecord(record))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
