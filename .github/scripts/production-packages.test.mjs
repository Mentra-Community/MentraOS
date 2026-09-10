import assert from "node:assert/strict"
import test from "node:test"

import {
  STABLE_CONTAINER_BODY,
  createProductionPackagesPlan,
  npmCandidateTag,
  planStableContainer,
  requireStableContainer,
  stableContainerPayload,
} from "./production-packages.mjs"
import {createReleasePlan, loadReleaseFamily, releaseRecordSha256} from "./release-family.mjs"

const family = loadReleaseFamily()
const betaPlan = createReleasePlan({
  family,
  channel: "beta",
  sequence: 192,
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: 310000192,
})
const betaManifest = {
  schemaVersion: 1,
  releaseSetId: betaPlan.releaseSetId,
  releaseIdentity: betaPlan.releaseIdentity,
  familyBaseVersion: betaPlan.familyBaseVersion,
  channel: "beta",
  sourceCommit: betaPlan.sourceCommit,
  native: betaPlan.native,
  releasePlanSha256: releaseRecordSha256(betaPlan),
  completedAt: "2026-09-10T10:00:00.000Z",
  otaManifest: {url: "https://example.com/ota.json", sha256: "d".repeat(64)},
}
const betaManifestUrl = `https://github.com/Mentra-Community/MentraOS/releases/download/mentra-builds-v${betaPlan.familyBaseVersion}/beta.json`

function packagesPlan(overrides = {}) {
  return createProductionPackagesPlan({
    family,
    betaPlan,
    betaManifest,
    betaManifestUrl,
    betaManifestSha256: "b".repeat(64),
    ...overrides,
  })
}

test("derives a deterministic production plan from the frozen beta source", () => {
  const plan = packagesPlan()
  assert.equal(plan.channel, "production")
  assert.equal(plan.releaseIdentity, family.familyBaseVersion)
  assert.equal(plan.sourceCommit, betaPlan.sourceCommit)
  assert.equal(plan.artifactContainerTag, `mentra-v${family.familyBaseVersion}`)
  assert.equal(plan.native.buildNumber, betaPlan.native.buildNumber)
  assert.deepEqual(plan.promotion, {
    selectedBetaReleaseSetId: betaPlan.releaseSetId,
    selectedBetaIdentity: betaPlan.releaseIdentity,
    selectedBetaManifest: {url: betaManifestUrl, sha256: "b".repeat(64)},
    otaManifest: betaManifest.otaManifest,
  })
  for (const member of Object.values(plan.members)) assert.equal(member.version, plan.releaseIdentity)
  assert.deepEqual(packagesPlan(), plan)
})

test("rejects an incomplete, mismatched, or unpinned beta", () => {
  assert.throws(() => packagesPlan({betaManifest: {...betaManifest, completedAt: undefined}}), /not complete/)
  assert.throws(() => packagesPlan({betaManifest: {...betaManifest, sourceCommit: "e".repeat(40)}}), /do not match/)
  assert.throws(
    () =>
      packagesPlan({betaManifest: {...betaManifest, otaManifest: {url: "http://example.com", sha256: "d".repeat(64)}}}),
    /OTA manifest pin/,
  )
  assert.throws(() => packagesPlan({betaManifestUrl: "http://example.com/beta.json"}), /must be HTTPS/)
  assert.throws(() => packagesPlan({betaManifestSha256: "nope"}), /SHA-256/)
  assert.throws(
    () => packagesPlan({betaPlan: {...betaPlan, changelog: {...betaPlan.changelog, sha256: "0".repeat(64)}}}),
    /do not match|changelog/,
  )
})

test("names a candidate dist-tag that npm cannot mistake for a version", () => {
  assert.equal(npmCandidateTag("3.1.0"), "candidate-3.1.0")
  assert.match(npmCandidateTag("3.1.0"), /^[a-z][a-z0-9._-]*$/)
  assert.throws(() => npmCandidateTag("3.1.0-beta.1"), /X\.Y\.Z/)
})

test("allocates or reuses the stable draft container the rollout finalization also uses", () => {
  const plan = packagesPlan()
  const payload = stableContainerPayload(plan)
  assert.deepEqual(payload, {
    tag_name: plan.artifactContainerTag,
    target_commitish: plan.sourceCommit,
    name: plan.artifactContainerName,
    body: STABLE_CONTAINER_BODY,
    draft: true,
    prerelease: false,
  })
  assert.deepEqual(planStableContainer([], plan), {action: "create", payload})
  const release = {id: 7, ...payload}
  assert.deepEqual(planStableContainer([{id: 1, tag_name: "other"}, release], plan), {action: "reuse", release})
  assert.throws(() => planStableContainer([release, {...release, id: 8}], plan), /Multiple releases/)
  assert.throws(() => requireStableContainer({...release, draft: false}, plan), /does not match/)
  assert.throws(() => requireStableContainer({...release, target_commitish: "b".repeat(40)}, plan), /does not match/)
  assert.throws(() => stableContainerPayload(betaPlan), /production plan is required/)
})
