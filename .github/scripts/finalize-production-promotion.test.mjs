import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {createHash} from "node:crypto"

import {finalizeProductionPromotion} from "./finalize-production-promotion.mjs"
import {productionOtaArtifacts, productionOtaSources} from "./production-ota-assets.mjs"
import {publishProductionReleasePage} from "./publish-coordinated-release-page.mjs"
import {
  createInitialPromotionRecord,
  PROMOTION_STATES,
  transitionPromotionRecord,
} from "./production-promotion-state.mjs"
import {createReleasePlan, familyBuildNumber, loadReleaseFamily} from "./release-family.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const family = loadReleaseFamily({rootDir: root})
const baseVersion = family.familyBaseVersion
const selectedBetaIdentity = `${baseVersion}-beta.101`
const plan = createReleasePlan({
  family,
  channel: "production",
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: familyBuildNumber(family.familyBaseVersion, 102),
})
plan.promotion = {
  selectedBetaReleaseSetId: `mentra-${selectedBetaIdentity}`,
  selectedBetaIdentity,
  selectedBetaManifest: {url: "https://example.com/beta.json", sha256: "b".repeat(64)},
  otaManifest: {
    status: "promoted",
    coordinate: `mentra-live-ota-${selectedBetaIdentity}.json`,
    url: "https://example.com/ota.json",
    sha256: createHash("sha256").update("beta OTA manifest").digest("hex"),
  },
}

// The promoted beta's record and the bytes of its OTA manifest and bundle.
const otaFiles = {otaManifest: Buffer.from("beta OTA manifest"), otaBundle: Buffer.from("beta OTA bundle")}
const betaManifest = {
  releaseIdentity: selectedBetaIdentity,
  releaseSetId: `mentra-${selectedBetaIdentity}`,
  channel: "beta",
  otaManifest: plan.promotion.otaManifest,
  artifacts: [
    {
      coordinate: `mentra-live-ota-bundle-${selectedBetaIdentity}.zip`,
      url: "https://example.com/bundle.zip",
      sha256: createHash("sha256").update(otaFiles.otaBundle).digest("hex"),
    },
  ],
}
const otaSources = productionOtaSources({plan, betaManifest, betaManifestSha256: "b".repeat(64)})
const otaArtifacts = productionOtaArtifacts({
  plan,
  sources: otaSources,
  files: otaFiles,
  repository: "Mentra-Community/MentraOS",
  provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1",
})

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
        provenance: "coordinated",
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
          ios: {marketingVersion: baseVersion, buildNumber: familyBuildNumber(family.familyBaseVersion, 102)},
          android: {marketingVersion: baseVersion, buildNumber: familyBuildNumber(family.familyBaseVersion, 102)},
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

function storeObservedFinalizingRecord() {
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
        provenance: "store-observed",
        sourceCommit: null,
        provenanceUrl: null,
        ios: {marketingVersion: "3.0", buildNumber: 51180073},
        android: {marketingVersion: "3.0", buildNumber: 51180031},
      },
      compatibilityLab: null,
      candidates: {
        mentraApp: {
          ios: {marketingVersion: baseVersion, buildNumber: familyBuildNumber(family.familyBaseVersion, 102)},
          android: {marketingVersion: baseVersion, buildNumber: familyBuildNumber(family.familyBaseVersion, 102)},
        },
      },
    },
    actor: "release-owner",
    createdAt: "2026-08-28T10:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1",
    evidence: [evidence("selected-beta-manifest")],
  })
  assert.equal(record.state, "staging-compatible")
  for (const state of PROMOTION_STATES.slice(2, PROMOTION_STATES.indexOf("finalizing") + 1)) {
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

test("finalizes a first promotion whose current app was only store-observed", () => {
  const record = storeObservedFinalizingRecord()
  const manifest = finalizeProductionPromotion({
    plan,
    record,
    checkpointUrl: `https://github.com/Mentra-Community/MentraOS/releases/download/promotion/${record.promotionId}.json`,
    otaArtifacts,
  })
  assert.equal(manifest.kind, "mentra-production-release")
  assert.equal(manifest.native.buildNumber, familyBuildNumber(family.familyBaseVersion, 102))
  assert.ok(!record.evidence.some(({kind}) => kind.startsWith("staging-mobile-n")))
})

test("a coordinated current app still needs both Phase 2 evidence kinds to finalize", () => {
  const record = finalizingRecord()
  const withoutLab = {
    ...record,
    evidence: record.evidence.filter(({kind}) => kind !== "staging-mobile-n-compatibility-lab"),
  }
  assert.throws(
    () => finalizeProductionPromotion({plan, record: withoutLab, checkpointUrl: "https://example.com/checkpoint.json", otaArtifacts}),
    /missing staging-mobile-n-compatibility-lab evidence/,
  )
})

test("creates the canonical production manifest from the finalizing checkpoint", () => {
  const record = finalizingRecord()
  const manifest = finalizeProductionPromotion({
    plan,
    record,
    checkpointUrl: `https://github.com/Mentra-Community/MentraOS/releases/download/promotion/${record.promotionId}.json`,
    otaArtifacts,
  })
  assert.equal(manifest.kind, "mentra-production-release")
  assert.equal(manifest.releaseIdentity, baseVersion)
  assert.equal(manifest.native.buildNumber, familyBuildNumber(family.familyBaseVersion, 102))
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
        otaArtifacts,
      }),
    /expected finalizing/,
  )
  const wrongPlan = structuredClone(plan)
  wrongPlan.native.buildNumber += 1
  assert.throws(
    () => finalizeProductionPromotion({plan: wrongPlan, record, checkpointUrl: "https://example.com/checkpoint.json", otaArtifacts}),
    /Mentra App iOS/,
  )
})

test("production publishes byte-identical copies of the promoted beta's OTA manifest and bundle", () => {
  assert.deepEqual(
    otaArtifacts.map(({coordinate}) => coordinate),
    [`mentra-live-ota-${baseVersion}.json`, `mentra-live-ota-bundle-${baseVersion}.zip`],
  )
  assert.deepEqual(
    otaArtifacts.map(({promotedFrom}) => promotedFrom.coordinate),
    [`mentra-live-ota-${selectedBetaIdentity}.json`, `mentra-live-ota-bundle-${selectedBetaIdentity}.zip`],
  )
  assert.equal(otaArtifacts[1].url, `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/mentra-v${baseVersion}/mentra-live-ota-bundle-${baseVersion}.zip`)
  assert.ok(otaArtifacts.every(({status}) => status === "promoted"))

  const record = finalizingRecord()
  const manifest = finalizeProductionPromotion({plan, record, checkpointUrl: "https://example.com/checkpoint.json", otaArtifacts})
  // The record lists the copies; the SDK keeps pinning the beta's manifest.
  assert.deepEqual(manifest.artifacts, otaArtifacts)
  assert.deepEqual(manifest.otaManifest, plan.promotion.otaManifest)
  for (const invalid of [undefined, otaArtifacts.slice(0, 1), [otaArtifacts[1], otaArtifacts[0]]]) {
    assert.throws(
      () => finalizeProductionPromotion({plan, record, checkpointUrl: "https://example.com/checkpoint.json", otaArtifacts: invalid}),
      /promoted OTA manifest and bundle copies/,
    )
  }

  // Bytes that differ from the beta's are never published.
  assert.throws(
    () =>
      productionOtaArtifacts({
        plan,
        sources: otaSources,
        files: {...otaFiles, otaBundle: Buffer.from("rebuilt bundle")},
        repository: "Mentra-Community/MentraOS",
        provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1",
      }),
    /not a byte-identical copy/,
  )
  // Only the beta the release was promoted from, and only one that has a bundle.
  assert.throws(
    () => productionOtaSources({plan, betaManifest, betaManifestSha256: "e".repeat(64)}),
    /not the one the production release was promoted from/,
  )
  assert.throws(
    () => productionOtaSources({plan, betaManifest: {...betaManifest, artifacts: []}, betaManifestSha256: "b".repeat(64)}),
    /published no mentra-live-ota-bundle-/,
  )

  // The stable release's download page lists the copies and is only edited.
  const calls = []
  const api = (route, options = {}) => {
    calls.push([route, options.method || "GET"])
    if (!options.method) return {id: 7, tag_name: `mentra-v${baseVersion}`, draft: true, prerelease: false, body: "Notes"}
    return {id: 7, body: options.data.body}
  }
  const release = publishProductionReleasePage({plan, manifest, repository: "Mentra-Community/MentraOS", releaseId: "7", api})
  assert.deepEqual(calls, [
    ["repos/Mentra-Community/MentraOS/releases/7", "GET"],
    ["repos/Mentra-Community/MentraOS/releases/7", "PATCH"],
  ])
  assert.match(release.body, /^Notes\n\n<!-- mentra-release-downloads:start -->/)
  assert.ok(release.body.includes(`[Glasses OTA bundle](${otaArtifacts[1].url})`))
  assert.ok(release.body.includes(`[Glasses OTA manifest](${otaArtifacts[0].url})`))
  assert.match(release.body, new RegExp(`promoted from beta ${selectedBetaIdentity.replaceAll(".", "\\.")}`))
})
