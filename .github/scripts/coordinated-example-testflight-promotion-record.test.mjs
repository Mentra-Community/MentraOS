import assert from "node:assert/strict"
import test from "node:test"

import {createExampleTestflightPromotionRecord} from "./coordinated-example-testflight-promotion-record.mjs"

const betaIdentity = "3.1.0-beta.57"
const betaSet = `mentra-${betaIdentity}`
const betaTestflight = {
  releaseSetId: betaSet,
  app: {id: "6792839366", bundleId: "com.mentra.bluetoothsdkexample"},
  version: {marketingVersion: "3.1.0", buildNumber: 310000057},
  build: {id: "build-57", processingState: "VALID"},
  provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/57",
}
const betaManifest = {
  releaseSetId: betaSet,
  releaseIdentity: betaIdentity,
  starterKit: {testflight: betaTestflight},
}
const plan = {
  releaseSetId: "mentra-3.1.0",
  releaseIdentity: "3.1.0",
  channel: "production",
  native: {marketingVersion: "3.1.0", buildNumber: 310000057},
  promotion: {selectedBetaReleaseSetId: betaSet, selectedBetaIdentity: betaIdentity},
}

function input(overrides = {}) {
  return {
    plan,
    betaManifest,
    appId: "6792839366",
    bundleId: "com.mentra.bluetoothsdkexample",
    buildId: "build-57",
    groupId: "group-production",
    groupName: "Mentra Production Public",
    installUrl: "https://testflight.apple.com/join/production123",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/100",
    ...overrides,
  }
}

test("records promotion of the selected approved beta example build", () => {
  const record = createExampleTestflightPromotionRecord(input())
  assert.equal(record.selectedBetaIdentity, betaIdentity)
  assert.equal(record.build.id, betaTestflight.build.id)
  assert.equal(record.distribution.reviewState, "APPROVED")
})

test("rejects a production build other than the selected beta build", () => {
  assert.throws(() => createExampleTestflightPromotionRecord(input({buildId: "build-other"})), /differs/)
})
