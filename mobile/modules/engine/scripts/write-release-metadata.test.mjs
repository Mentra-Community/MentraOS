import assert from "node:assert/strict"
import test from "node:test"

import {renderReleaseMetadata, validateReleaseMetadata} from "./write-release-metadata.mjs"

const validInput = {
  familyBaseVersion: "3.1.0",
  releaseIdentity: "3.1.0-beta.57",
  releaseSetId: "mentra-3.1.0-beta.57",
  sourceCommit: "a".repeat(40),
  otaManifestUrl: "https://updates.example.com/mentra/3.1.0-beta.57/version.json",
  otaManifestSha256: "b".repeat(64),
}

test("renders literal, deterministic Engine release metadata", () => {
  const first = renderReleaseMetadata(validInput)
  const second = renderReleaseMetadata({...validInput})

  assert.equal(first, second)
  assert.match(first, /mentra-3\.1\.0-beta\.57/)
  assert.match(first, /https:\/\/updates\.example\.com\/mentra\/3\.1\.0-beta\.57\/version\.json/)
  assert.match(first, new RegExp("b".repeat(64)))
  assert.doesNotMatch(first, /process\.env/)
})

test("rejects mismatched or unsafe release metadata", () => {
  assert.throws(() => validateReleaseMetadata({...validInput, releaseIdentity: "3.2.0-beta.57"}), /does not belong/)
  assert.throws(() => validateReleaseMetadata({...validInput, releaseSetId: "mentra-else"}), /releaseSetId/)
  assert.throws(
    () => validateReleaseMetadata({...validInput, otaManifestUrl: "http://updates.example.com/version.json"}),
    /must use HTTPS/,
  )
  assert.throws(() => validateReleaseMetadata({...validInput, otaManifestSha256: "ABC"}), /lowercase SHA-256/)
})
