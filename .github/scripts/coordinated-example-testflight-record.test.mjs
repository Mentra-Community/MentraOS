import assert from "node:assert/strict"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {createExampleTestflightRecord} from "./coordinated-example-testflight-record.mjs"

const plan = {
  releaseSetId: "mentra-3.1.0-dev.45",
  releaseIdentity: "3.1.0-dev.45",
  familyBaseVersion: "3.1.0",
  channel: "dev",
  sourceCommit: "a".repeat(40),
  native: {marketingVersion: "3.1.0", buildNumber: 310000045},
}

function input(overrides = {}) {
  return {
    plan,
    appId: "6792839366",
    bundleId: "com.mentra.bluetoothsdkexample",
    buildId: "build-1",
    groupId: "group-1",
    groupName: "Mentra Dev",
    audience: "internal",
    distributionStatus: "available",
    installUrl: "https://appstoreconnect.apple.com/apps/6792839366/testflight",
    uploadStatus: "published",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1",
    ...overrides,
  }
}

test("records the exact coordinated example TestFlight build", () => {
  const root = mkdtempSync(path.join(tmpdir(), "example-testflight-"))
  const ipa = path.join(root, "example.ipa")
  writeFileSync(ipa, "signed ipa")
  const record = createExampleTestflightRecord(input({ipa}))
  assert.equal(record.schemaVersion, 2)
  assert.equal(record.mentraosSourceCommit, plan.sourceCommit)
  assert.equal(record.starterKitReleaseCommit, undefined)
  assert.equal(record.version.buildNumber, 310000045)
  assert.equal(record.group.id, "group-1")
  assert.match(record.ipa.sha256, /^[0-9a-f]{64}$/)
})

test("requires the channel's exact TestFlight group", () => {
  assert.throws(
    () => createExampleTestflightRecord(input({groupName: "Mentra Staging"})),
    /TestFlight group must be Mentra Dev/,
  )
})

test("records a skipped beta build while an earlier review is pending", () => {
  const betaPlan = {
    ...plan,
    releaseSetId: "mentra-3.1.0-beta.46",
    releaseIdentity: "3.1.0-beta.46",
    channel: "beta",
    sourceCommit: "c".repeat(40),
  }
  const record = createExampleTestflightRecord(
    input({
      plan: betaPlan,
      buildId: "build-skipped",
      uploadStatus: "published",
      groupName: "Mentra Staging Public",
      audience: "external",
      distributionStatus: "skipped",
      installUrl: "https://testflight.apple.com/join/public123",
      reviewState: "WAITING_FOR_REVIEW",
      skipReason: "external_review_waiting_for_review",
      skipDetail: "build-pending",
    }),
  )
  assert.equal(record.build.id, "build-skipped")
  assert.equal(record.distribution.status, "skipped")
  assert.equal(record.distribution.reviewState, "WAITING_FOR_REVIEW")
})

test("records an independently allocated production example candidate", () => {
  const productionPlan = {
    ...plan,
    releaseSetId: "mentra-3.1.0",
    releaseIdentity: "3.1.0",
    channel: "production",
  }
  const record = createExampleTestflightRecord(
    input({
      plan: productionPlan,
      groupName: "Mentra Bluetooth Example",
      audience: "external",
      installUrl: "https://testflight.apple.com/join/production123",
      buildNumber: 310000099,
    }),
  )
  assert.equal(record.channel, "production")
  assert.equal(record.version.buildNumber, 310000099)
})

test("rejects a plan without a coordinated identity and source", () => {
  assert.throws(
    () => createExampleTestflightRecord(input({plan: {...plan, releaseSetId: "mentra-3.1.0-dev.44"}})),
    /coordinated release plan with a source commit/,
  )
  assert.throws(
    () => createExampleTestflightRecord(input({plan: {...plan, sourceCommit: "main"}})),
    /coordinated release plan with a source commit/,
  )
})
