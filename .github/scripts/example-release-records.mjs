#!/usr/bin/env node
// The Mentra Bluetooth example release is its own release notion.
//
// A coordinated Mentra beta (Cloud V2, the Mentra App, the Engine, and the
// Bluetooth SDK) is complete when its own finalize step writes
// mentra-release-<identity>.json. The Starter Kit examples are built afterwards
// against that finalized beta, published to their own stores, and recorded here
// as mentra-example-release-<identity>.json. An example that fails to build or
// publish therefore never makes the beta incomplete, and the production
// promotion of the beta does not depend on it.
import {createHash} from "node:crypto"
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {validateExampleGooglePlay} from "./coordinated-example-google-play.mjs"
import {requirePublicHttpsUrl, serializeReleaseRecord} from "./release-family.mjs"

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
export const EXAMPLE_RELEASE_KIND = "mentra-bluetooth-example"

export function exampleReleaseAssetName(releaseIdentity) {
  return `mentra-example-release-${releaseIdentity}.json`
}

function requireIsoUtc(value, label) {
  const parsed = new Date(value)
  if (!value || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`)
  }
  return value
}

export function verifyExampleTestflight(plan, starterKit, exampleTestflight) {
  const expectedGroup = plan.channel === "dev" ? "Mentra Dev" : "Mentra Staging Public"
  const expectedAudience = plan.channel === "dev" ? "internal" : "external"
  const distribution = exampleTestflight?.distribution
  if (
    exampleTestflight?.schemaVersion !== 1 ||
    exampleTestflight.releaseSetId !== plan.releaseSetId ||
    exampleTestflight.releaseIdentity !== plan.releaseIdentity ||
    exampleTestflight.channel !== plan.channel ||
    exampleTestflight.mentraosSourceCommit !== plan.sourceCommit ||
    exampleTestflight.starterKitReleaseCommit !== starterKit.starterKit?.releaseCommit ||
    exampleTestflight.app?.id !== "6792839366" ||
    exampleTestflight.app?.bundleId !== "com.mentra.bluetoothsdkexample" ||
    exampleTestflight.version?.marketingVersion !== plan.native.marketingVersion ||
    exampleTestflight.version?.buildNumber !== plan.native.buildNumber ||
    exampleTestflight.build?.processingState !== "VALID" ||
    !["published", "reused"].includes(exampleTestflight.build?.uploadStatus) ||
    typeof exampleTestflight.build?.id !== "string" ||
    exampleTestflight.build.id.length === 0 ||
    exampleTestflight.group?.name !== expectedGroup ||
    typeof exampleTestflight.group?.id !== "string" ||
    exampleTestflight.group.id.length === 0 ||
    distribution?.audience !== expectedAudience ||
    !["available", "submitted", "skipped"].includes(distribution?.status) ||
    !/^https:\/\//.test(distribution?.installUrl || "") ||
    !/^https:\/\//.test(exampleTestflight.provenanceUrl || "")
  ) {
    throw new Error("Example TestFlight result does not match the release plan and Starter Kit source")
  }
  if (
    exampleTestflight.ipa !== undefined &&
    (!SHA256_PATTERN.test(exampleTestflight.ipa.sha256 || "") ||
      !Number.isSafeInteger(exampleTestflight.ipa.size) ||
      exampleTestflight.ipa.size < 1)
  ) {
    throw new Error("Example TestFlight IPA evidence is invalid")
  }
  if (plan.channel === "dev" && distribution.status !== "available") {
    throw new Error("Internal example TestFlight distribution must be available")
  }
  if (expectedAudience === "external" && !/^https:\/\/testflight\.apple\.com\/join\//.test(distribution.installUrl)) {
    throw new Error("External example TestFlight distribution must use a public invitation link")
  }
  if (distribution.status === "skipped" && !distribution.skipReason) {
    throw new Error("Skipped example TestFlight distribution must identify its reason")
  }
  return exampleTestflight
}

export function verifyStarterKitResult(plan, starterKit, resultUrl, exampleTestflight, exampleGooglePlay) {
  if (
    starterKit?.schemaVersion !== 1 ||
    starterKit.releaseSetId !== plan.releaseSetId ||
    starterKit.releaseIdentity !== plan.releaseIdentity ||
    starterKit.familyBaseVersion !== plan.familyBaseVersion ||
    starterKit.channel !== plan.channel ||
    starterKit.mentraos?.sourceCommit !== plan.sourceCommit ||
    !COMMIT_PATTERN.test(starterKit.starterKit?.baseCommit || "")
  ) {
    throw new Error("Starter Kit result does not match the release plan")
  }
  for (const packageName of ["@mentra/bluetooth-sdk", "@mentra/engine"]) {
    if (starterKit.packages?.[packageName] !== plan.releaseIdentity) {
      throw new Error(`Starter Kit ${packageName} version does not match the release plan`)
    }
  }
  if (!/^https:\/\//.test(resultUrl || "")) throw new Error("Starter Kit result URL must be public HTTPS")
  if (!/^https:\/\//.test(starterKit.starterKit?.validationRunUrl || "")) {
    throw new Error("Starter Kit validation run URL must be public HTTPS")
  }
  if (!Array.isArray(starterKit.artifacts) || ![3, 4].includes(starterKit.artifacts.length)) {
    throw new Error("Starter Kit result must contain the three required examples and optional native Android")
  }
  const keys = new Set()
  const artifacts = starterKit.artifacts.map((artifact) => {
    if (
      !artifact?.key ||
      keys.has(artifact.key) ||
      typeof artifact.name !== "string" ||
      !artifact.name.includes(plan.releaseIdentity) ||
      !/^https:\/\//.test(artifact.url || "") ||
      !SHA256_PATTERN.test(artifact.sha256 || "") ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 1
    ) {
      throw new Error("Starter Kit contains an invalid or duplicate example artifact")
    }
    keys.add(artifact.key)
    return {
      status: "published",
      coordinate: artifact.name,
      url: artifact.url,
      sha256: artifact.sha256,
      size: artifact.size,
      provenanceUrl: starterKit.starterKit.validationRunUrl,
    }
  })
  for (const key of ["ios", "reactNative", "reactNativeElevenLabsAudio"]) {
    if (!keys.has(key)) throw new Error(`Starter Kit result is missing ${key}`)
  }
  return {
    record: {
      ...starterKit,
      resultUrl,
      testflight: verifyExampleTestflight(plan, starterKit, exampleTestflight),
      googlePlay: validateExampleGooglePlay(plan, starterKit, exampleGooglePlay),
    },
    artifacts,
  }
}

function verifyBetaManifest(plan, betaManifest, betaManifestUrl, betaManifestSha256) {
  if (
    betaManifest?.schemaVersion !== 1 ||
    betaManifest.releaseSetId !== plan.releaseSetId ||
    betaManifest.releaseIdentity !== plan.releaseIdentity ||
    betaManifest.channel !== plan.channel ||
    betaManifest.sourceCommit !== plan.sourceCommit ||
    typeof betaManifest.completedAt !== "string"
  ) {
    throw new Error("The example release requires the finalized manifest of the same coordinated beta")
  }
  requireIsoUtc(betaManifest.completedAt, "betaManifest.completedAt")
  if (!SHA256_PATTERN.test(betaManifestSha256 || "")) {
    throw new Error("betaManifest.sha256 must be a lowercase SHA-256 digest")
  }
  return {
    name: plan.artifactNames.releaseManifest,
    url: requirePublicHttpsUrl(betaManifestUrl, "betaManifest.url"),
    sha256: betaManifestSha256,
    completedAt: betaManifest.completedAt,
  }
}

export function assembleExampleReleaseResults({
  plan,
  betaManifest,
  betaManifestUrl,
  betaManifestSha256,
  starterKit,
  starterKitResultUrl,
  exampleTestflight,
  exampleGooglePlay,
  completedAt,
  provenanceUrl,
}) {
  if (plan?.releaseSetId !== `mentra-${plan?.releaseIdentity}` || plan.channel === "production") {
    throw new Error("The example release requires a coordinated dev or beta release plan")
  }
  const beta = verifyBetaManifest(plan, betaManifest, betaManifestUrl, betaManifestSha256)
  const verified = verifyStarterKitResult(plan, starterKit, starterKitResultUrl, exampleTestflight, exampleGooglePlay)
  return {
    schemaVersion: 1,
    kind: EXAMPLE_RELEASE_KIND,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    familyBaseVersion: plan.familyBaseVersion,
    channel: plan.channel,
    sourceCommit: plan.sourceCommit,
    betaManifest: beta,
    starterKit: verified.record,
    artifacts: verified.artifacts,
    completedAt: requireIsoUtc(completedAt, "completedAt"),
    provenanceUrl: requirePublicHttpsUrl(provenanceUrl, "provenanceUrl"),
  }
}

export function validateExampleReleaseRecord(record, plan) {
  if (
    record?.schemaVersion !== 1 ||
    record.kind !== EXAMPLE_RELEASE_KIND ||
    record.releaseSetId !== plan.releaseSetId ||
    record.releaseIdentity !== plan.releaseIdentity ||
    record.channel !== plan.channel ||
    record.sourceCommit !== plan.sourceCommit ||
    record.betaManifest?.name !== plan.artifactNames.releaseManifest ||
    !SHA256_PATTERN.test(record.betaManifest?.sha256 || "") ||
    !Array.isArray(record.artifacts) ||
    record.artifacts.length < 3 ||
    !COMMIT_PATTERN.test(record.starterKit?.starterKit?.mergeCommit || "")
  ) {
    throw new Error("Example release record does not describe a finalized Mentra Bluetooth example")
  }
  requirePublicHttpsUrl(record.betaManifest.url, "betaManifest.url")
  requireIsoUtc(record.betaManifest.completedAt, "betaManifest.completedAt")
  requireIsoUtc(record.completedAt, "completedAt")
  requirePublicHttpsUrl(record.provenanceUrl, "provenanceUrl")
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

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const betaManifestBytes = readFileSync(path.resolve(args["beta-manifest"]))
  const record = assembleExampleReleaseResults({
    plan: readJson(args.plan),
    betaManifest: JSON.parse(betaManifestBytes.toString("utf8")),
    betaManifestUrl: args["beta-manifest-url"],
    betaManifestSha256: createHash("sha256").update(betaManifestBytes).digest("hex"),
    starterKit: readJson(args["starter-kit"]),
    starterKitResultUrl: args["starter-kit-result-url"],
    exampleTestflight: readJson(args["example-testflight"]),
    exampleGooglePlay: readJson(args["example-google-play"]),
    completedAt: args["completed-at"],
    provenanceUrl: args["provenance-url"],
  })
  writeFileSync(path.resolve(args.output), serializeReleaseRecord(record))
  console.log(`Wrote ${record.kind} ${record.releaseIdentity} to ${args.output}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
