import assert from "node:assert/strict"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  createPrivateDeploymentRecord,
  validatePrivateDeploymentRecord,
} from "./coordinated-private-deployment-records.mjs"
import {createReleasePlan, loadReleaseFamily} from "./release-family.mjs"

const sourceCommit = "a".repeat(40)
const plan = createReleasePlan({
  family: loadReleaseFamily({rootDir: fileURLToPath(new URL("../..", import.meta.url))}),
  channel: "dev",
  sequence: 91,
  sourceCommit,
  nativeBuildNumber: 310000091,
})

function runtimeImage(status = "published") {
  return {
    status,
    image: "ghcr.io/mentra-community/mentra-cloud",
    digest: status === "published" ? `sha256:${"b".repeat(64)}` : undefined,
  }
}
const workspaceOrigin = "https://enterprisedev.mentraglass.com"
const coreHostname = "ca-mentra-ent-ref-core.gentlehill-4ed63a4c.westus2.azurecontainerapps.io"
const coreOrigin = `https://${coreHostname}`

function create(status = "deployed") {
  return createPrivateDeploymentRecord({
    plan,
    sourceCommit,
    requestedTag: sourceCommit,
    status,
    sourceImage: status === "deployed" ? "ghcr.io/mentra-community/mentra-cloud" : undefined,
    sourceImageDigest: status === "deployed" ? `sha256:${"b".repeat(64)}` : undefined,
    image:
      status === "deployed"
        ? `mentraenterpriseref.azurecr.io/mentra-cloud-enterprise@sha256:${"b".repeat(64)}`
        : undefined,
    imageDigest: status === "deployed" ? `sha256:${"b".repeat(64)}` : undefined,
    revision: status === "deployed" ? "ca-mentra-enterprise-reference--0000091" : undefined,
    coreRevision: status === "deployed" ? "ca-mentra-ent-ref-core--0000091" : undefined,
    workspaceOrigin: status === "deployed" ? workspaceOrigin : undefined,
    coreHostname: status === "deployed" ? coreHostname : undefined,
    coreOrigin: status === "deployed" ? coreOrigin : undefined,
    checks:
      status === "deployed"
        ? [workspaceOrigin, coreOrigin].flatMap((origin) =>
            ["healthz", "ready"].map((probe) => ({
              url: `${origin}/${probe}`,
              ready: true,
              statusCode: 200,
            })),
          )
        : undefined,
    completedAt: "2026-09-01T12:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123",
  })
}

test("records an immutable release-matched Private Deployment", () => {
  const record = create()
  assert.equal(record.sourceCommit, plan.sourceCommit)
  assert.equal(record.azure.requestedTag, plan.sourceCommit)
  assert.equal(record.azure.imageDigest, `sha256:${"b".repeat(64)}`)
  assert.equal(record.source.image, "ghcr.io/mentra-community/mentra-cloud")
  assert.equal(record.source.imageDigest, record.azure.imageDigest)
  assert.equal(
    validatePrivateDeploymentRecord({plan, record, runtimeImage: runtimeImage()}).azure.revision,
    record.azure.revision,
  )
})

test("permits validation-only evidence only when explicitly requested", () => {
  const record = create("validated")
  assert.throws(() => validatePrivateDeploymentRecord({plan, record}), /not a completed deployment/)
  assert.equal(validatePrivateDeploymentRecord({plan, record, allowValidated: true}).status, "validated")
})

test("rejects mutable or mismatched deployment evidence", () => {
  const wrongDigest = structuredClone(create())
  wrongDigest.azure.imageDigest = "latest"
  assert.throws(() => validatePrivateDeploymentRecord({plan, record: wrongDigest}), /canonical GHCR source/)

  const wrongSource = structuredClone(create())
  wrongSource.sourceCommit = "c".repeat(40)
  assert.throws(
    () => validatePrivateDeploymentRecord({plan, record: wrongSource}),
    /do not match a dev release plan/,
  )

  const rebuilt = structuredClone(create())
  rebuilt.azure.imageDigest = `sha256:${"d".repeat(64)}`
  rebuilt.azure.image = `mentraenterpriseref.azurecr.io/mentra-cloud-enterprise@${rebuilt.azure.imageDigest}`
  assert.throws(() => validatePrivateDeploymentRecord({plan, record: rebuilt}), /canonical GHCR source/)

  const substitutedPublication = runtimeImage()
  substitutedPublication.digest = `sha256:${"d".repeat(64)}`
  assert.throws(
    () => validatePrivateDeploymentRecord({plan, record: create(), runtimeImage: substitutedPublication}),
    /does not match the coordinated Mentra Cloud image/,
  )

  assert.throws(
    () => createPrivateDeploymentRecord({...deploymentArgs(), coreOrigin: "https://unrelated.example.com"}),
    /expected Azure Core Container App ingress/,
  )
})

test("rejects look-alike or non-default-port Core origins", () => {
  for (const lookAlike of [
    `${coreOrigin}.evil.example`,
    `https://${coreHostname.replace(".gentlehill-", ".gentlehil1-")}`,
    `https://ca-mentra-ent-ref-core.gentlehill-4ed63a4c.westus2.azurecontainerapps.io.example.com`,
  ]) {
    assert.throws(
      () => createPrivateDeploymentRecord({...deploymentArgs(), coreOrigin: lookAlike}),
      /expected Azure Core Container App ingress/,
      lookAlike,
    )
  }
  assert.throws(
    () => createPrivateDeploymentRecord({...deploymentArgs(), coreOrigin: `${coreOrigin}:8443`}),
    /expected Azure Core Container App ingress/,
  )
  for (const badHostname of [
    undefined,
    "",
    "ca-mentra-ent-ref-core.example.azurecontainerapps.io",
    "ca-mentra-ent-ref-core.gentlehill-4ed63a4c.westus2.azurecontainerapps.io.example.com",
  ]) {
    assert.throws(
      () => createPrivateDeploymentRecord({...deploymentArgs(), coreHostname: badHostname}),
      /coreHostname must be/,
      String(badHostname),
    )
  }
  const recorded = structuredClone(create())
  recorded.azure.coreHostname = "ca-mentra-ent-ref-core.happyfield-0123abcd.westus2.azurecontainerapps.io"
  assert.throws(
    () => validatePrivateDeploymentRecord({plan, record: recorded}),
    /expected Azure Core Container App ingress/,
  )
})

test("rejects deployed evidence with the wrong workspace origin", () => {
  assert.throws(
    () => createPrivateDeploymentRecord({...deploymentArgs(), workspaceOrigin: "https://enterprisedev.mentraglass.com.evil.example"}),
    /wrong workspace origin/,
  )
  const recorded = structuredClone(create())
  recorded.workspaceOrigin = "https://enterprisedev-mentraglass.example"
  assert.throws(() => validatePrivateDeploymentRecord({plan, record: recorded}), /wrong workspace origin/)
})

test("rejects deployed evidence without string revisions", () => {
  for (const revision of [undefined, "", {}, 91]) {
    assert.throws(
      () => createPrivateDeploymentRecord({...deploymentArgs(), revision}),
      /missing immutable Azure image evidence/,
      `revision ${JSON.stringify(revision)}`,
    )
    assert.throws(
      () => createPrivateDeploymentRecord({...deploymentArgs(), coreRevision: revision}),
      /missing immutable Azure image evidence/,
      `coreRevision ${JSON.stringify(revision)}`,
    )
  }
  const missingRevision = structuredClone(create())
  delete missingRevision.azure.revision
  assert.throws(
    () => validatePrivateDeploymentRecord({plan, record: missingRevision}),
    /missing immutable Azure image evidence/,
  )
  const objectRevision = structuredClone(create())
  objectRevision.azure.coreRevision = {}
  assert.throws(
    () => validatePrivateDeploymentRecord({plan, record: objectRevision}),
    /missing immutable Azure image evidence/,
  )
})

test("rejects a recorded requestedTag that differs from the plan", () => {
  const retagged = structuredClone(create())
  retagged.azure.requestedTag = "c".repeat(40)
  assert.throws(
    () => validatePrivateDeploymentRecord({plan, record: retagged}),
    /does not match the release plan and target/,
  )
  const validatedRetag = structuredClone(create("validated"))
  validatedRetag.azure.requestedTag = "c".repeat(40)
  assert.throws(
    () => validatePrivateDeploymentRecord({plan, record: validatedRetag, allowValidated: true}),
    /does not match the release plan and target/,
  )
  assert.throws(
    () => createPrivateDeploymentRecord({...deploymentArgs(), requestedTag: "c".repeat(40)}),
    /requestedTag must equal the full sourceCommit/,
  )
})

test("validation-only evidence must not carry a Core hostname", () => {
  const record = structuredClone(create("validated"))
  record.azure.coreHostname = coreHostname
  assert.throws(
    () => validatePrivateDeploymentRecord({plan, record, allowValidated: true}),
    /must not claim a live deployment/,
  )
})

function deploymentArgs() {
  return {
    plan,
    sourceCommit,
    requestedTag: sourceCommit,
    status: "deployed",
    sourceImage: "ghcr.io/mentra-community/mentra-cloud",
    sourceImageDigest: `sha256:${"b".repeat(64)}`,
    image: `mentraenterpriseref.azurecr.io/mentra-cloud-enterprise@sha256:${"b".repeat(64)}`,
    imageDigest: `sha256:${"b".repeat(64)}`,
    revision: "ca-mentra-enterprise-reference--0000091",
    coreRevision: "ca-mentra-ent-ref-core--0000091",
    workspaceOrigin,
    coreHostname,
    coreOrigin,
    checks: [workspaceOrigin, coreOrigin].flatMap((origin) =>
      ["healthz", "ready"].map((probe) => ({url: `${origin}/${probe}`, ready: true, statusCode: 200})),
    ),
    completedAt: "2026-09-01T12:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123",
  }
}
