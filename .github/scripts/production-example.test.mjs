import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {EXAMPLE_BUNDLE_ID, allocateExampleBuildNumber, createProductionExamplePlan} from "./production-example.mjs"
import {createReleasePlan, loadReleaseFamily, releaseRecordSha256} from "./release-family.mjs"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const family = loadReleaseFamily({rootDir})
const betaPlan = createReleasePlan({
  family,
  channel: "beta",
  sequence: 212,
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: 310000212,
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
  completedAt: "2026-09-11T18:00:00.000Z",
  otaManifest: {url: "https://example.com/mentra-live-ota-3.1.0-beta.212.json", sha256: "d".repeat(64)},
}
const apple = (maxBuildNumber) => ({bundleId: EXAMPLE_BUNDLE_ID, current: null, maxBuildNumber})
const google = (maxVersionCode) => ({packageName: EXAMPLE_BUNDLE_ID, currentVersionCode: null, maxVersionCode})

test("allocates one example build number above both stores and the promoted beta", () => {
  assert.equal(
    allocateExampleBuildNumber({betaPlan, appleInventory: apple(310000200), googleInventory: google(1)}),
    310000213,
  )
  assert.equal(
    allocateExampleBuildNumber({betaPlan, appleInventory: apple(310000300), googleInventory: google(2)}),
    310000301,
  )
  assert.equal(
    allocateExampleBuildNumber({betaPlan, appleInventory: apple(1), googleInventory: google(310000400)}),
    310000401,
  )
  assert.equal(allocateExampleBuildNumber({betaPlan, appleInventory: apple(1)}), 310000213)
  assert.throws(
    () => allocateExampleBuildNumber({betaPlan, appleInventory: {bundleId: "com.mentra.mentra", maxBuildNumber: 1}}),
    /does not identify/,
  )
  assert.throws(
    () =>
      allocateExampleBuildNumber({
        betaPlan,
        appleInventory: apple(1),
        googleInventory: {packageName: "other", maxVersionCode: 1},
      }),
    /does not identify/,
  )
})

test("freezes a production example plan keyed on the promoted beta with the allocated build number", () => {
  const plan = createProductionExamplePlan({
    family,
    betaPlan,
    betaManifest,
    betaManifestUrl:
      "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-builds-v3.1.0/mentra-release-3.1.0-beta.212.json",
    betaManifestSha256: "b".repeat(64),
    buildNumber: 310000213,
  })
  assert.equal(plan.channel, "production")
  assert.equal(plan.releaseIdentity, family.familyBaseVersion)
  assert.equal(plan.sourceCommit, betaPlan.sourceCommit)
  assert.equal(plan.native.buildNumber, 310000213)
  assert.equal(plan.artifactContainerTag, `mentra-v${family.familyBaseVersion}`)
  assert.deepEqual(plan.promotion.otaManifest, betaManifest.otaManifest)
  assert.equal(plan.promotion.selectedBetaIdentity, betaPlan.releaseIdentity)
  assert.equal(plan.example.testflight.group, "Mentra SDK Example Production Candidates")
  assert.equal(plan.example.testflight.audience, "internal")
  assert.equal(plan.example.googlePlay.track, "internal")
  assert.equal(plan.example.storePromotion, "never")
  assert.throws(
    () =>
      createProductionExamplePlan({
        family,
        betaPlan,
        betaManifest,
        betaManifestUrl: "https://example.com/beta.json",
        betaManifestSha256: "b".repeat(64),
        buildNumber: 310000212,
      }),
    /above the selected beta/,
  )
  assert.throws(
    () =>
      createProductionExamplePlan({
        family,
        betaPlan,
        betaManifest: {...betaManifest, completedAt: undefined},
        betaManifestUrl: "https://example.com/beta.json",
        betaManifestSha256: "b".repeat(64),
        buildNumber: 310000213,
      }),
    /not complete/,
  )
})
