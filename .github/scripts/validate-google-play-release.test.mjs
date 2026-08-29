import assert from "node:assert/strict"
import test from "node:test"

import {validateGooglePlayDraft, validateGooglePlayRollout} from "./validate-google-play-release.mjs"

function inventory(status, userFraction) {
  return {
    packageName: "com.mentra.mentra",
    releases: {
      production: [
        {name: "3.0.0", status: "completed", userFraction: null, versionCodes: [300000100]},
        {name: "3.1.0", status, userFraction, versionCodes: [310000100]},
      ],
    },
  }
}

test("accepts only an exact unreleased Google Play draft during submission", () => {
  const result = validateGooglePlayDraft(inventory("draft", null), 310000100)
  assert.equal(result.requiredState, "draft")
  assert.equal(result.status, "draft")
  assert.throws(() => validateGooglePlayDraft(inventory("inProgress", 0.1), 310000100), /unreleased draft/)
  assert.throws(() => validateGooglePlayDraft(inventory("completed", null), 310000100), /unreleased draft/)
})

test("accepts only an exact active or completed Google Play rollout", () => {
  assert.deepEqual(validateGooglePlayRollout(inventory("inProgress", 0.1), 310000100), {
    schemaVersion: 1,
    kind: "google-play-production-release-state",
    packageName: "com.mentra.mentra",
    versionCode: 310000100,
    requiredState: "public",
    status: "inProgress",
    userFraction: 0.1,
    releaseName: "3.1.0",
  })
  assert.equal(validateGooglePlayRollout(inventory("completed", null), 310000100).status, "completed")
})

test("rejects drafts, halted releases, missing fractions, and another version as public", () => {
  assert.throws(() => validateGooglePlayRollout(inventory("draft", null), 310000100), /not public/)
  assert.throws(() => validateGooglePlayRollout(inventory("halted", 0.1), 310000100), /not public/)
  assert.throws(() => validateGooglePlayRollout(inventory("inProgress", null), 310000100), /rollout fraction/)
  assert.throws(() => validateGooglePlayRollout(inventory("completed", null), 310000101), /exactly one/)
})
