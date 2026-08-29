import assert from "node:assert/strict"
import test from "node:test"

import {prepareProductionPromotion} from "./prepare-production-promotion.mjs"
import {createReleasePlan, loadReleaseFamily, releaseRecordSha256} from "./release-family.mjs"

const family = loadReleaseFamily()
const betaPlan = createReleasePlan({
  family,
  channel: "beta",
  sequence: 57,
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: 310000057,
})
const betaManifest = {
  schemaVersion: 1,
  releaseSetId: betaPlan.releaseSetId,
  releaseIdentity: betaPlan.releaseIdentity,
  familyBaseVersion: betaPlan.familyBaseVersion,
  channel: "beta",
  sourceCommit: betaPlan.sourceCommit,
  native: betaPlan.native,
  releasePlanSha256: releaseRecordSha256(betaPlan),
  completedAt: "2026-08-28T10:00:00.000Z",
  starterKit: {starterKit: {releaseCommit: "c".repeat(40)}},
  otaManifest: {url: "https://example.com/ota.json", sha256: "d".repeat(64)},
}
const previousManifest = {
  releaseIdentity: "3.0.0",
  sourceCommit: "f".repeat(40),
  native: {marketingVersion: "3.0.0", buildNumber: 300000100},
  url: "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-v3.0.0/manifest.json",
}

function inventory(bundleId, current, appleMax, googleMax) {
  return {
    apple: {bundleId, current, maxBuildNumber: appleMax},
    google: {
      packageName: bundleId,
      currentVersionCode: current?.buildNumber ?? null,
      maxVersionCode: googleMax,
    },
  }
}

function prepare(overrides = {}) {
  return prepareProductionPromotion({
    family,
    betaPlan,
    betaManifest,
    betaManifestUrl: "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-builds-v3.1.0/beta.json",
    betaManifestSha256: "b".repeat(64),
    previousManifest,
    mentraInventory: inventory(
      "com.mentra.mentra",
      {marketingVersion: "3.0.0", buildNumber: 300000100},
      310000060,
      310000059,
    ),
    starterKitInventory: inventory("com.mentra.bluetoothsdkexample", null, 42, 0),
    starterKitCommit: "d".repeat(40),
    attempt: 1,
    actor: "release-owner",
    createdAt: "2026-08-28T20:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123",
    ...overrides,
  })
}

test("freezes selected source and allocates new store build numbers", () => {
  const {productionPlan, record} = prepare()
  assert.equal(productionPlan.channel, "production")
  assert.equal(record.coordinates.compatibilityLab.ios.buildNumber, 310000061)
  assert.equal(productionPlan.native.buildNumber, 310000062)
  assert.equal(record.coordinates.candidates.mentraApp.ios.buildNumber, 310000062)
  assert.equal(record.coordinates.candidates.starterKit.android.buildNumber, 310000063)
  assert.equal(record.source.starterKitCommit, "d".repeat(40))
  assert.deepEqual(productionPlan.promotion.otaManifest, betaManifest.otaManifest)
  assert.equal(record.coordinates.currentMentraApp.sourceCommit, "f".repeat(40))
})

test("rejects store state that does not match current production provenance", () => {
  assert.throws(
    () =>
      prepare({
        mentraInventory: inventory(
          "com.mentra.mentra",
          {marketingVersion: "3.0.0", buildNumber: 300000099},
          310000060,
          310000059,
        ),
      }),
    /do not match the previous production manifest/,
  )
})

test("rejects an incomplete selected beta or missing Starter Kit provenance", () => {
  assert.throws(() => prepare({betaManifest: {...betaManifest, completedAt: undefined}}), /not complete/)
  assert.throws(() => prepare({betaManifest: {...betaManifest, starterKit: undefined}}), /Starter Kit/)
})
