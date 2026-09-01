import assert from "node:assert/strict"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  createEnterpriseRuntimeDeploymentRecord,
  validateEnterpriseRuntimeDeploymentRecord,
} from "./coordinated-enterprise-runtime-records.mjs"
import {createReleasePlan, loadReleaseFamily} from "./release-family.mjs"

const sourceCommit = "a".repeat(40)
const plan = createReleasePlan({
  family: loadReleaseFamily({rootDir: fileURLToPath(new URL("../..", import.meta.url))}),
  channel: "dev",
  sequence: 91,
  sourceCommit,
  nativeBuildNumber: 310000091,
})
const workspaceOrigin = "https://enterprise.example.com"

function create(status = "deployed") {
  return createEnterpriseRuntimeDeploymentRecord({
    plan,
    sourceCommit,
    requestedTag: sourceCommit,
    status,
    image:
      status === "deployed"
        ? `mentraenterpriseref.azurecr.io/mentra-runtime-enterprise:${sourceCommit}`
        : undefined,
    imageDigest: status === "deployed" ? `sha256:${"b".repeat(64)}` : undefined,
    revision: status === "deployed" ? "ca-mentra-enterprise-reference--0000091" : undefined,
    workspaceOrigin: status === "deployed" ? workspaceOrigin : undefined,
    checks:
      status === "deployed"
        ? ["healthz", "ready"].map((probe) => ({
            url: `${workspaceOrigin}/${probe}`,
            ready: true,
            statusCode: 200,
          }))
        : undefined,
    completedAt: "2026-09-01T12:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123",
  })
}

test("records an immutable release-matched enterprise Runtime deployment", () => {
  const record = create()
  assert.equal(record.sourceCommit, plan.sourceCommit)
  assert.equal(record.azure.requestedTag, plan.sourceCommit)
  assert.equal(record.azure.imageDigest, `sha256:${"b".repeat(64)}`)
  assert.equal(validateEnterpriseRuntimeDeploymentRecord({plan, record}).azure.revision, record.azure.revision)
})

test("permits validation-only evidence only when explicitly requested", () => {
  const record = create("validated")
  assert.throws(
    () => validateEnterpriseRuntimeDeploymentRecord({plan, record}),
    /not a completed deployment/,
  )
  assert.equal(
    validateEnterpriseRuntimeDeploymentRecord({plan, record, allowValidated: true}).status,
    "validated",
  )
})

test("rejects mutable or mismatched deployment evidence", () => {
  const wrongDigest = structuredClone(create())
  wrongDigest.azure.imageDigest = "latest"
  assert.throws(
    () => validateEnterpriseRuntimeDeploymentRecord({plan, record: wrongDigest}),
    /immutable Azure image evidence/,
  )

  const wrongSource = structuredClone(create())
  wrongSource.sourceCommit = "c".repeat(40)
  assert.throws(
    () => validateEnterpriseRuntimeDeploymentRecord({plan, record: wrongSource}),
    /do not match a dev release plan/,
  )
})
