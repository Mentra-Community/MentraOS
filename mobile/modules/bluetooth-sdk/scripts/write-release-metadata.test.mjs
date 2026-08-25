import assert from "node:assert/strict"
import test from "node:test"

import {renderReleaseMetadata, validateReleaseMetadata} from "./write-release-metadata.mjs"

const input = {
  familyBaseVersion: "3.1.0",
  releaseIdentity: "3.1.0-beta.57",
  releaseSetId: "mentra-3.1.0-beta.57",
  sourceCommit: "a".repeat(40),
  otaManifestUrl:
    "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-3.1.0-beta.57/mentra-live-ota-3.1.0-beta.57.json",
  otaManifestSha256: "b".repeat(64),
}

test("renders identical immutable metadata for TypeScript, Kotlin, and Swift", () => {
  const rendered = renderReleaseMetadata(input)
  for (const contents of [rendered.typescript, rendered.kotlin, rendered.swift]) {
    assert.match(contents, /3\.1\.0-beta\.57/)
    assert.match(contents, /mentra-live-ota-3\.1\.0-beta\.57\.json/)
    assert.match(contents, new RegExp("b".repeat(64)))
  }
})

test("rejects mutable or cross-family release metadata", () => {
  assert.throws(() => validateReleaseMetadata({...input, releaseIdentity: "3.2.0-beta.57"}), /does not belong/)
  assert.throws(() => validateReleaseMetadata({...input, otaManifestUrl: "http://example.com/version.json"}), /HTTPS/)
  assert.throws(() => validateReleaseMetadata({...input, otaManifestSha256: "short"}), /SHA-256/)
})
