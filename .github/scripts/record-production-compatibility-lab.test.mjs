import assert from "node:assert/strict"
import test from "node:test"

import {createCompatibilityLabEvidence} from "./record-production-compatibility-lab.mjs"

const sha = (value) => value.repeat(64)
const record = {
  schemaVersion: 1,
  kind: "mentra-production-promotion",
  promotionId: "mentra-3.1.0-attempt-1",
  releaseIdentity: "3.1.0",
  attempt: 1,
  state: "selected",
  sequence: 0,
  previous: null,
  createdAt: "2026-08-28T20:00:00.000Z",
  actor: "owner",
  provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1",
  selectedBeta: {
    identity: "3.1.0-beta.57",
    releaseSetId: "mentra-3.1.0-beta.57",
    manifestUrl: "https://example.com/beta.json",
    manifestSha256: sha("b"),
  },
  source: {mentraosCommit: sha("a").slice(0, 40)},
  coordinates: {
    currentMentraApp: {
      sourceCommit: sha("f").slice(0, 40),
      provenanceUrl: "https://example.com/current.json",
      ios: {marketingVersion: "3.0.0", buildNumber: 100},
      android: {marketingVersion: "3.0.0", buildNumber: 100},
    },
    compatibilityLab: {
      ios: {marketingVersion: "3.0.0", buildNumber: 101},
      android: {marketingVersion: "3.0.0", buildNumber: 101},
    },
    candidates: {
      mentraApp: {
        ios: {marketingVersion: "3.1.0", buildNumber: 102},
        android: {marketingVersion: "3.1.0", buildNumber: 102},
      },
    },
  },
  evidence: [],
}
const plan = {
  schemaVersion: 1,
  channel: "beta",
  sourceCommit: record.coordinates.currentMentraApp.sourceCommit,
  familyBaseVersion: "3.0.0",
  releaseIdentity: "3.0.0-beta.101",
  releaseSetId: "mentra-3.0.0-beta.101",
  native: {marketingVersion: "3.0.0", buildNumber: 101},
  artifactNames: {androidStoreApp: "lab.aab", iosApp: "lab.ipa"},
  compatibilityLab: {
    promotionId: record.promotionId,
    targetCloudSource: record.source.mentraosCommit,
    runtimeLabel: "3.0.0-beta.101-COMPATIBILITY-LAB-NOT-FOR-PRODUCTION",
    nonPromotable: true,
    iosDistribution: "testflight-internal-only",
    androidDistribution: "google-play-internal-app-sharing",
  },
}
const mobile = {
  releaseSetId: plan.releaseSetId,
  publications: {
    mentraos: {
      "app-store-connect": {
        status: "published",
        coordinate: "com.mentra.mentra:3.0.0:101:Mentra Compatibility Lab",
        provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/2",
      },
      "google-play": {
        status: "published",
        coordinate: "com.mentra.mentra:101:internal-app-sharing",
        provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/2",
      },
    },
  },
  artifacts: [
    {coordinate: "lab.aab", sha256: sha("d")},
    {coordinate: "lab.ipa", sha256: sha("e")},
  ],
}
const sharing = {
  downloadUrl: "https://play.google.com/apps/test/example",
  sha256: sha("d"),
  certificateFingerprint: "AA:BB",
}

test("records exact non-promotable lab distributions", () => {
  const evidence = createCompatibilityLabEvidence({
    record,
    plan,
    mobile,
    internalSharing: sharing,
    createdAt: "2026-08-28T21:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/2",
  })
  assert.equal(evidence.ios.internalOnly, true)
  assert.equal(evidence.android.downloadUrl, sharing.downloadUrl)
  assert.equal(evidence.source.mobileNCommit, record.coordinates.currentMentraApp.sourceCommit)
})

test("rejects internal-sharing evidence for a different AAB", () => {
  assert.throws(
    () =>
      createCompatibilityLabEvidence({
        record,
        plan,
        mobile,
        internalSharing: {...sharing, sha256: sha("0")},
        createdAt: "2026-08-28T21:00:00.000Z",
        provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/2",
      }),
    /does not match the built AAB/,
  )
})
