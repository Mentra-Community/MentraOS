import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {finalizeProductionPromotion} from "./finalize-production-promotion.mjs"
import {
  createInitialPromotionRecord,
  PROMOTION_STATES,
  transitionPromotionRecord,
} from "./production-promotion-state.mjs"
import {createReleasePlan, loadReleaseFamily} from "./release-family.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const family = loadReleaseFamily({rootDir: root})
const baseVersion = family.familyBaseVersion
const selectedBetaIdentity = `${baseVersion}-beta.101`
const plan = createReleasePlan({
  family,
  channel: "production",
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: 310000102,
})
plan.promotion = {
  selectedBetaReleaseSetId: `mentra-${selectedBetaIdentity}`,
  selectedBetaIdentity,
  selectedBetaManifest: {url: "https://example.com/beta.json", sha256: "b".repeat(64)},
  otaManifest: {
    status: "promoted",
    coordinate: `mentra-live-ota-${selectedBetaIdentity}.json`,
    url: "https://example.com/ota.json",
    sha256: "c".repeat(64),
  },
}

const kinds = new Map([
  ["staging-compatible", "staging-mobile-n-compatibility"],
  ["production-config-ready", "production-cloud-config-preflight"],
  ["cloud-deployed", "production-cloud-v2-deployment"],
  ["current-clients-accepted", "production-mobile-n-compatibility"],
  ["mobile-candidates-uploaded", "production-mobile-candidates"],
  ["mobile-candidates-accepted", "production-mobile-candidate-acceptance"],
  ["stores-submitted", "production-store-submissions"],
  ["stores-approved", "store-review-approved"],
  ["public-release-approved", "production-public-release-approval"],
  ["rolling-out", "production-public-rollout-started"],
  ["finalizing", "production-rollout-observation"],
])

function evidence(kind, sha256 = "d".repeat(64)) {
  return {
    kind,
    url: `https://example.com/${kind}.json`,
    sha256,
    assetName: kind === "production-rollout-observation" ? `production-rollout-100-${sha256}.json` : `${kind}.json`,
  }
}

function finalizingRecord() {
  let record = createInitialPromotionRecord({
    releaseIdentity: baseVersion,
    attempt: 2,
    selectedBeta: {
      identity: selectedBetaIdentity,
      releaseSetId: `mentra-${selectedBetaIdentity}`,
      manifestUrl: "https://example.com/beta.json",
      manifestSha256: "b".repeat(64),
    },
    source: {mentraosCommit: "a".repeat(40)},
    coordinates: {
      currentMentraApp: {
        sourceCommit: "f".repeat(40),
        provenanceUrl: "https://example.com/current.json",
        ios: {marketingVersion: "3.0.0", buildNumber: 300000100},
        android: {marketingVersion: "3.0.0", buildNumber: 300000100},
      },
      compatibilityLab: {
        ios: {marketingVersion: "3.0.0", buildNumber: 310000101},
        android: {marketingVersion: "3.0.0", buildNumber: 310000101},
      },
      candidates: {
        mentraApp: {
          ios: {marketingVersion: baseVersion, buildNumber: 310000102},
          android: {marketingVersion: baseVersion, buildNumber: 310000102},
        },
      },
    },
    actor: "release-owner",
    createdAt: "2026-08-28T10:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1",
    evidence: [evidence("selected-beta-manifest")],
  })
  record = transitionPromotionRecord({
    record,
    to: "selected",
    actor: "release-owner",
    createdAt: "2026-08-28T10:01:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/2",
    evidence: evidence("staging-mobile-n-compatibility-lab"),
  })
  for (const state of PROMOTION_STATES.slice(1, PROMOTION_STATES.indexOf("finalizing") + 1)) {
    record = transitionPromotionRecord({
      record,
      to: state,
      actor: "release-owner",
      createdAt: `2026-08-28T10:${String(record.sequence + 2).padStart(2, "0")}:00.000Z`,
      provenanceUrl: `https://github.com/Mentra-Community/MentraOS/actions/runs/${record.sequence + 3}`,
      evidence: evidence(kinds.get(state)),
    })
  }
  return record
}

test("creates the canonical production manifest from the finalizing checkpoint", () => {
  const record = finalizingRecord()
  const manifest = finalizeProductionPromotion({
    plan,
    record,
    checkpointUrl: `https://github.com/Mentra-Community/MentraOS/releases/download/promotion/${record.promotionId}.json`,
  })
  assert.equal(manifest.kind, "mentra-production-release")
  assert.equal(manifest.releaseIdentity, baseVersion)
  assert.equal(manifest.native.buildNumber, 310000102)
  assert.deepEqual(Object.keys(manifest.applications), ["mentraApp"])
  assert.equal(manifest.promotion.attempt, 2)
  assert.equal(manifest.promotion.checkpoint.state, "finalizing")
  assert.equal(manifest.completedAt, record.createdAt)
})

test("rejects incomplete or mismatched finalization inputs", () => {
  const record = finalizingRecord()
  assert.throws(
    () =>
      finalizeProductionPromotion({
        plan,
        record: {...record, state: "rolling-out"},
        checkpointUrl: "https://example.com/checkpoint.json",
      }),
    /expected finalizing/,
  )
  const wrongPlan = structuredClone(plan)
  wrongPlan.native.buildNumber += 1
  assert.throws(
    () => finalizeProductionPromotion({plan: wrongPlan, record, checkpointUrl: "https://example.com/checkpoint.json"}),
    /Mentra App iOS/,
  )
})
