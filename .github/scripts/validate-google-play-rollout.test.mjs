import assert from "node:assert/strict"
import test from "node:test"

import {validateGooglePlayRollout} from "./validate-google-play-rollout.mjs"

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

test("accepts only an exact active or completed Google Play rollout", () => {
  assert.deepEqual(validateGooglePlayRollout(inventory("inProgress", 0.1), 310000100), {
    schemaVersion: 1,
    kind: "google-play-public-rollout",
    packageName: "com.mentra.mentra",
    versionCode: 310000100,
    status: "inProgress",
    userFraction: 0.1,
    releaseName: "3.1.0",
  })
  assert.equal(validateGooglePlayRollout(inventory("completed", null), 310000100).status, "completed")
})

test("rejects drafts, halted releases, missing fractions, and another version", () => {
  assert.throws(() => validateGooglePlayRollout(inventory("draft", null), 310000100), /not public/)
  assert.throws(() => validateGooglePlayRollout(inventory("halted", 0.1), 310000100), /not public/)
  assert.throws(() => validateGooglePlayRollout(inventory("inProgress", null), 310000100), /rollout fraction/)
  assert.throws(() => validateGooglePlayRollout(inventory("completed", null), 310000101), /exactly one/)
})
