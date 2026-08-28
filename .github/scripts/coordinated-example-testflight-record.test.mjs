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

const starterKit = {
  releaseSetId: plan.releaseSetId,
  releaseIdentity: plan.releaseIdentity,
  mentraos: {sourceCommit: plan.sourceCommit},
  starterKit: {releaseCommit: "b".repeat(40)},
}

function input(overrides = {}) {
  return {
    plan,
    starterKit,
    appId: "6792839366",
    bundleId: "com.mentra.bluetoothsdkexample",
    buildId: "build-1",
    groupId: "group-1",
    groupName: "Mentra Dev",
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
  assert.equal(record.starterKitReleaseCommit, "b".repeat(40))
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

test("rejects a Starter Kit result from another release", () => {
  assert.throws(
    () => createExampleTestflightRecord(input({starterKit: {...starterKit, releaseIdentity: "3.1.0-dev.44"}})),
    /Starter Kit result does not match/,
  )
})
