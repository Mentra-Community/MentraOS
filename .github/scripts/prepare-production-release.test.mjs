import assert from "node:assert/strict"
import test from "node:test"

import {releaseRecordSha256} from "./release-family.mjs"
import {prepareProductionRelease} from "./prepare-production-release.mjs"

const family = {
  familyBaseVersion: "3.1.0",
  changelog: {version: "3.1.0", path: "changelogs/3.1.0.md", sha256: "f".repeat(64)},
  products: ["mentraos"],
  publicationOrder: ["mentraos"],
  members: [
    {
      name: "mentraos",
      manifest: "mobile/package.json",
      kind: "product",
      publishTargets: ["app-store-connect", "google-play"],
      dependencies: [],
    },
  ],
}

const betaPlan = {
  schemaVersion: 1,
  releaseSetId: "mentra-3.1.0-beta.57",
  familyBaseVersion: "3.1.0",
  releaseIdentity: "3.1.0-beta.57",
  artifactContainerTag: "mentra-builds-v3.1.0",
  artifactContainerName: "Mentra 3.1.0 development builds",
  channel: "beta",
  sequence: 57,
  sourceCommit: "a".repeat(40),
  native: {marketingVersion: "3.1.0", buildNumber: 310000057},
  products: {mentraos: "3.1.0-beta.57"},
  members: {
    mentraos: {
      version: "3.1.0-beta.57",
      kind: "product",
      manifest: "mobile/package.json",
      publishTargets: ["app-store-connect", "google-play"],
      dependencies: {},
    },
  },
  publicationOrder: ["mentraos"],
  artifactNames: {
    releaseManifest: "mentra-release-3.1.0-beta.57.json",
    otaBundle: "mentra-live-ota-bundle-3.1.0-beta.57.zip",
    asgSelection: "mentra-live-asg-selection-3.1.0-beta.57.json",
    androidApp: "mentraos-3.1.0-beta.57-android.apk",
    androidStoreApp: "mentraos-3.1.0-beta.57-android.aab",
    iosApp: "mentraos-3.1.0-beta.57-ios.ipa",
  },
  otaInputs: {firmwareManifest: {sha256: "b".repeat(64)}},
}

function artifact(coordinate, provenanceUrl = "https://github.com/example/actions/runs/mobile") {
  return {
    status: "published",
    coordinate,
    url: `https://example.com/${coordinate}`,
    sha256: "c".repeat(64),
    provenanceUrl,
  }
}

function manifest() {
  return {
    releaseSetId: betaPlan.releaseSetId,
    releaseIdentity: betaPlan.releaseIdentity,
    channel: "beta",
    sourceCommit: betaPlan.sourceCommit,
    releasePlanSha256: releaseRecordSha256(betaPlan),
    otaManifest: artifact("mentra-live-ota-3.1.0-beta.57.json", "https://github.com/example/actions/runs/ota"),
    artifacts: [
      artifact(betaPlan.artifactNames.androidApp),
      artifact(betaPlan.artifactNames.androidStoreApp),
      artifact(betaPlan.artifactNames.iosApp),
      artifact(betaPlan.artifactNames.otaBundle),
      artifact(betaPlan.artifactNames.asgSelection),
      {...artifact("mentra-live-asg-100057.apk"), signingCertificateSha256: "e".repeat(64)},
    ],
  }
}

test("derives a stable plan while preserving the selected beta bytes and native build", () => {
  const result = prepareProductionRelease({
    family,
    betaPlan,
    betaManifest: manifest(),
    betaManifestSha256: "d".repeat(64),
    repository: "Mentra-Community/MentraOS",
  })
  assert.equal(result.productionPlan.releaseIdentity, "3.1.0")
  assert.equal(result.productionPlan.sourceCommit, betaPlan.sourceCommit)
  assert.equal(result.productionPlan.native.buildNumber, betaPlan.native.buildNumber)
  assert.equal(result.selection.mobileArtifacts.androidAab.coordinate, betaPlan.artifactNames.androidStoreApp)
  assert.equal(result.selection.otaManifest.sha256, "c".repeat(64))
  assert.equal(
    result.productionPlan.promotion.selectedBetaManifest.url,
    "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-builds-v3.1.0/mentra-release-3.1.0-beta.57.json",
  )
  assert.equal(result.selection.otaArtifacts.length, 3)
  assert.deepEqual(
    result.selection.otaArtifacts.map(({coordinate}) => coordinate),
    [betaPlan.artifactNames.otaBundle, betaPlan.artifactNames.asgSelection, "mentra-live-asg-100057.apk"],
  )
})

test("selects OTA artifacts correctly when every job shares one workflow provenance URL", () => {
  const betaManifest = manifest()
  const shared = "https://github.com/Mentra-Community/MentraOS/actions/runs/123"
  betaManifest.otaManifest.provenanceUrl = shared
  for (const entry of betaManifest.artifacts) entry.provenanceUrl = shared

  const {selection} = prepareProductionRelease({
    family,
    betaPlan,
    betaManifest,
    betaManifestSha256: "d".repeat(64),
    repository: "Mentra-Community/MentraOS",
  })
  assert.equal(selection.otaArtifacts.length, 3)
})

test("rejects a beta manifest whose plan digest does not match", () => {
  const invalid = manifest()
  invalid.releasePlanSha256 = "0".repeat(64)
  assert.throws(
    () =>
      prepareProductionRelease({
        family,
        betaPlan,
        betaManifest: invalid,
        betaManifestSha256: "d".repeat(64),
        repository: "Mentra-Community/MentraOS",
      }),
    /plan digest/,
  )
})
