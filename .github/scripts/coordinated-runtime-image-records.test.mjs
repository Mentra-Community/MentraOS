import assert from "node:assert/strict"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {createRuntimeImageRecord, validateRuntimeImageRecord} from "./coordinated-runtime-image-records.mjs"
import {createReleasePlan, loadReleaseFamily} from "./release-family.mjs"

const sourceCommit = "a".repeat(40)
const plan = createReleasePlan({
  family: loadReleaseFamily({rootDir: fileURLToPath(new URL("../..", import.meta.url))}),
  channel: "dev",
  sequence: 91,
  sourceCommit,
  nativeBuildNumber: 310000091,
})

function create(status = "published") {
  return createRuntimeImageRecord({
    plan,
    sourceCommit,
    status,
    digest: status === "published" ? `sha256:${"b".repeat(64)}` : undefined,
    sbom:
      status === "published"
        ? {
            format: "spdx-json",
            name: `mentra-runtime-${plan.releaseIdentity}.spdx.json`,
            sha256: "c".repeat(64),
            size: 1234,
            attestationUrl: "https://github.com/Mentra-Community/MentraOS/attestations/456",
          }
        : undefined,
    provenanceAttestationUrl:
      status === "published" ? "https://github.com/Mentra-Community/MentraOS/attestations/123" : undefined,
    completedAt: "2026-09-02T12:00:00.000Z",
    workflowUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/789",
  })
}

test("records a digest-pinned Runtime image with signed SBOM and provenance", () => {
  const record = create()
  assert.equal(record.reference, `${record.image}@${record.digest}`)
  assert.equal(record.requestedTags.release, plan.releaseIdentity)
  assert.equal(record.requestedTags.source, plan.sourceCommit)
  assert.equal(record.provenance.predicateType, "https://slsa.dev/provenance/v1")
  assert.match(record.provenance.attestationUrl, /\/attestations\/123$/)
  assert.equal(validateRuntimeImageRecord({plan, record}).sbom.format, "spdx-json")
})

test("records verified provenance when a prior publication is reused", () => {
  const record = create()
  delete record.provenance.attestationUrl
  assert.equal(validateRuntimeImageRecord({plan, record}).provenance.repository, "Mentra-Community/MentraOS")
})

test("permits validation-only Runtime image evidence only when requested", () => {
  const record = create("validated")
  assert.throws(() => validateRuntimeImageRecord({plan, record}), /not a completed publication/)
  assert.equal(validateRuntimeImageRecord({plan, record, allowValidated: true}).status, "validated")
})

test("rejects mutable or mismatched Runtime image evidence", () => {
  const mutable = structuredClone(create())
  mutable.digest = "latest"
  assert.throws(() => validateRuntimeImageRecord({plan, record: mutable}), /immutable SHA-256 digest/)

  const wrongTag = structuredClone(create())
  wrongTag.requestedTags.release = "latest"
  assert.throws(() => validateRuntimeImageRecord({plan, record: wrongTag}), /does not match the release plan/)

  const missingProvenance = structuredClone(create())
  delete missingProvenance.provenance
  assert.throws(
    () => validateRuntimeImageRecord({plan, record: missingProvenance}),
    /requires verified build provenance/,
  )
})
