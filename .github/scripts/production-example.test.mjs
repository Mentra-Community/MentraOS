import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  EXAMPLE_BUNDLE_ID,
  allocateExampleBuildNumber,
  createProductionExamplePlan,
  reuseExistingExamplePlan,
} from "./production-example.mjs"
import {createReleasePlan, familyBuildNumber, loadReleaseFamily, releaseRecordSha256} from "./release-family.mjs"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const family = loadReleaseFamily({rootDir})
const betaPlan = createReleasePlan({
  family,
  channel: "beta",
  sequence: 212,
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: familyBuildNumber(family.familyBaseVersion, 212),
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
const n = (sequence) => familyBuildNumber(family.familyBaseVersion, sequence)

const marker = (sequence) => ({name: `mentra-build-number-${n(sequence)}.json`})

test("allocates the example's build number as the family's next sequence", () => {
  assert.equal(allocateExampleBuildNumber({betaPlan, familyAssets: [marker(212)]}), n(213))
  assert.equal(allocateExampleBuildNumber({betaPlan, familyAssets: [marker(212), marker(300)]}), n(301))
  // An ASG client pair of the family (the caller passes the shared ASG
  // release's assets too) holds its number like a marker does.
  assert.equal(
    allocateExampleBuildNumber({
      betaPlan,
      familyAssets: [marker(212), {name: `mentra-live-asg-${n(400)}-${"a".repeat(64)}.apk`}],
    }),
    n(401),
  )
  assert.throws(() => allocateExampleBuildNumber({betaPlan, familyAssets: []}), /does not record the selected beta/)
  assert.throws(
    () =>
      allocateExampleBuildNumber({
        betaPlan: {...betaPlan, native: {...betaPlan.native, buildNumber: 900000002}},
        familyAssets: [marker(212)],
      }),
    /outside the family window/,
  )
  assert.throws(() => allocateExampleBuildNumber({betaPlan, familyAssets: [marker(2999)]}), /exhausted/)
  // A retry finds the example's own reservation.
  const owned = {
    schemaVersion: 1,
    kind: "mentra-family-build-number",
    familyBaseVersion: family.familyBaseVersion,
    buildNumber: n(213),
    sequence: 213,
    owner: `example:mentra-${family.familyBaseVersion}`,
  }
  assert.equal(
    allocateExampleBuildNumber({
      betaPlan,
      familyAssets: [marker(212), marker(213), marker(214)],
      familyMarkers: [owned],
    }),
    n(213),
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
    buildNumber: n(213),
  })
  assert.equal(plan.channel, "production")
  assert.equal(plan.releaseIdentity, family.familyBaseVersion)
  assert.equal(plan.sourceCommit, betaPlan.sourceCommit)
  assert.equal(plan.native.buildNumber, n(213))
  assert.equal(plan.artifactContainerTag, `mentra-v${family.familyBaseVersion}`)
  assert.deepEqual(plan.promotion.otaManifest, betaManifest.otaManifest)
  assert.equal(plan.promotion.selectedBetaIdentity, betaPlan.releaseIdentity)
  assert.equal(plan.example.testflight.group, "Mentra Bluetooth Example")
  assert.equal(plan.example.testflight.audience, "external")
  assert.equal(plan.example.googlePlay.track, "Mentra Bluetooth Example Production Candidates")
  assert.equal(plan.example.storePromotion, "never")
  assert.throws(
    () =>
      createProductionExamplePlan({
        family,
        betaPlan,
        betaManifest,
        betaManifestUrl: "https://example.com/beta.json",
        betaManifestSha256: "b".repeat(64),
        buildNumber: n(212),
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
        buildNumber: n(213),
      }),
    /not complete/,
  )
})

test("a plan frozen by an earlier run is reused only for the same beta, source, and manifest", () => {
  const betaManifestUrl =
    "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-builds-v3.1.0/mentra-release-3.1.0-beta.212.json"
  const existingPlan = createProductionExamplePlan({
    family,
    betaPlan,
    betaManifest,
    betaManifestUrl,
    betaManifestSha256: "b".repeat(64),
    buildNumber: n(213),
  })
  assert.equal(
    reuseExistingExamplePlan({existingPlan, betaPlan, betaManifestUrl, betaManifestSha256: "b".repeat(64)}),
    existingPlan,
  )
  assert.throws(
    () => reuseExistingExamplePlan({existingPlan, betaPlan, betaManifestUrl, betaManifestSha256: "c".repeat(64)}),
    /describes different inputs/,
  )
  assert.throws(
    () =>
      reuseExistingExamplePlan({
        existingPlan,
        betaPlan: {...betaPlan, releaseIdentity: "3.1.0-beta.213", releaseSetId: "mentra-3.1.0-beta.213"},
        betaManifestUrl,
        betaManifestSha256: "b".repeat(64),
      }),
    /describes different inputs/,
  )
  assert.throws(
    () =>
      reuseExistingExamplePlan({
        existingPlan: {...existingPlan, example: {...existingPlan.example, storePromotion: "app-store"}},
        betaPlan,
        betaManifestUrl,
        betaManifestSha256: "b".repeat(64),
      }),
    /describes different inputs/,
  )
})
