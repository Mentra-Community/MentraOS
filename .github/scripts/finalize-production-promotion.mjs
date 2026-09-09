#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {promotionAssetName, validatePromotionRecord} from "./production-promotion-state.mjs"
import {releaseRecordSha256, requirePublicHttpsUrl, serializeReleaseRecord} from "./release-family.mjs"

function fail(message) {
  throw new Error(`Cannot finalize production promotion: ${message}`)
}

function requireMatchingCoordinate(actual, expected, label) {
  if (actual?.marketingVersion !== expected?.marketingVersion || actual?.buildNumber !== expected?.buildNumber) {
    fail(`${label} does not match the frozen production plan`)
  }
}

export function finalizeProductionPromotion({plan, record, checkpointUrl}) {
  validatePromotionRecord(record)
  if (record.state !== "finalizing") fail(`promotion state is ${record.state}, expected finalizing`)
  if (
    plan?.channel !== "production" ||
    plan.releaseSetId !== `mentra-${plan.releaseIdentity}` ||
    plan.releaseIdentity !== record.releaseIdentity ||
    plan.sourceCommit !== record.source.mentraosCommit
  ) {
    fail("plan and promotion identity do not match")
  }
  if (
    plan.promotion?.selectedBetaReleaseSetId !== record.selectedBeta.releaseSetId ||
    plan.promotion?.selectedBetaIdentity !== record.selectedBeta.identity ||
    plan.promotion?.selectedBetaManifest?.url !== record.selectedBeta.manifestUrl ||
    plan.promotion?.selectedBetaManifest?.sha256 !== record.selectedBeta.manifestSha256
  ) {
    fail("selected beta provenance does not match")
  }
  requireMatchingCoordinate(record.coordinates.candidates.mentraApp.ios, plan.native, "Mentra App iOS")
  requireMatchingCoordinate(record.coordinates.candidates.mentraApp.android, plan.native, "Mentra App Android")
  const rollout = record.evidence.at(-1)
  if (
    rollout?.kind !== "production-rollout-observation" ||
    !/^production-rollout-100-[0-9a-f]{64}\.json$/.test(rollout.assetName || "") ||
    !rollout.assetName.endsWith(`-${rollout.sha256}.json`)
  ) {
    fail("finalizing checkpoint is missing the immutable 100 percent rollout observation")
  }
  requirePublicHttpsUrl(checkpointUrl, "promotion checkpoint URL")
  const evidenceKinds = new Set(record.evidence.map(({kind}) => kind))
  for (const kind of [
    "staging-mobile-n-compatibility-lab",
    "staging-mobile-n-compatibility",
    "production-cloud-config-preflight",
    "production-cloud-v2-deployment",
    "production-mobile-n-compatibility",
    "production-mobile-candidates",
    "production-mobile-candidate-acceptance",
    "production-store-submissions",
    "store-review-approved",
    "production-public-release-approval",
    "production-public-rollout-started",
    "production-rollout-observation",
  ]) {
    if (!evidenceKinds.has(kind)) fail(`promotion chain is missing ${kind} evidence`)
  }

  return {
    schemaVersion: 1,
    kind: "mentra-production-release",
    releaseSetId: plan.releaseSetId,
    familyBaseVersion: plan.familyBaseVersion,
    changelog: plan.changelog,
    releaseIdentity: plan.releaseIdentity,
    channel: "production",
    sourceCommit: plan.sourceCommit,
    native: plan.native,
    completedAt: record.createdAt,
    releasePlanSha256: releaseRecordSha256(plan),
    artifactContainerTag: plan.artifactContainerTag,
    artifactContainerName: plan.artifactContainerName,
    applications: {
      mentraApp: record.coordinates.candidates.mentraApp,
    },
    releaseFamily: {
      members: Object.fromEntries(
        Object.entries(plan.members).map(([name, member]) => [
          name,
          {version: member.version, publishTargets: member.publishTargets},
        ]),
      ),
    },
    otaManifest: plan.promotion.otaManifest,
    promotion: {
      promotionId: record.promotionId,
      attempt: record.attempt,
      selectedBetaReleaseSetId: record.selectedBeta.releaseSetId,
      selectedBetaIdentity: record.selectedBeta.identity,
      selectedBetaManifest: {
        url: record.selectedBeta.manifestUrl,
        sha256: record.selectedBeta.manifestSha256,
      },
      checkpoint: {
        state: record.state,
        assetName: promotionAssetName(record),
        sha256: releaseRecordSha256(record),
        url: checkpointUrl,
      },
      evidence: record.evidence,
    },
  }
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
  const manifest = finalizeProductionPromotion({
    plan: readJson(args.plan),
    record: readJson(args.record),
    checkpointUrl: args["checkpoint-url"],
  })
  writeFileSync(path.resolve(args.output), serializeReleaseRecord(manifest))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
