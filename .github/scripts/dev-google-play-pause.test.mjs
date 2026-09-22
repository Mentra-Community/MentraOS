import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {createAndroidRecord, createIosRecord, mergeMobileRecords} from "./coordinated-mobile-records.mjs"
import {createPrivateDeploymentRecord} from "./coordinated-private-deployment-records.mjs"
import {cloudRecordForPlan} from "./coordinated-cloud-v2-test-helpers.mjs"
import {runtimeImageRecordForPlan} from "./coordinated-runtime-image-test-helpers.mjs"
import {createReleasePlan, familyBuildNumber, finalizeReleaseManifest, loadReleaseFamily} from "./release-family.mjs"

const family = loadReleaseFamily()
const input = {
  family,
  channel: "dev",
  sequence: 226,
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: familyBuildNumber(family.familyBaseVersion, 226),
}
const provenanceUrl = "https://github.com/Mentra-Community/MentraOS/actions/runs/123"

test("dev can finalize GitHub Android artifacts without a Google Play publication", (t) => {
  const plan = createReleasePlan({...input, uploadGooglePlay: false})
  assert.equal(plan.native.googlePlayUpload, false)
  assert.deepEqual(plan.members.mentraos.publishTargets, ["app-store-connect"])
  const root = mkdtempSync(path.join(tmpdir(), "dev-play-pause-"))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const files = Object.fromEntries(
    ["apk", "aab", "ipa"].map((kind) => {
      const file = path.join(root, `app.${kind}`)
      writeFileSync(file, kind)
      return [kind, file]
    }),
  )
  const android = createAndroidRecord({
    plan,
    apk: files.apk,
    aab: files.aab,
    apkUrl: "https://example.com/app.apk",
    aabUrl: "https://example.com/app.aab",
    storeStatus: "published",
    provenanceUrl,
  })
  assert.deepEqual(android.publications.mentraos, {})
  assert.deepEqual(
    android.artifacts.map((artifact) => artifact.coordinate),
    [plan.artifactNames.androidApp, plan.artifactNames.androidStoreApp],
  )
  const ios = createIosRecord({
    plan,
    ipa: files.ipa,
    ipaUrl: "https://example.com/app.ipa",
    testflightGroup: "Mentra Dev",
    storeStatus: "published",
    provenanceUrl,
  })
  const mobile = mergeMobileRecords({plan, android, ios})
  const publication = (coordinate) => ({
    status: "published",
    coordinate,
    url: "https://example.com/artifact",
    sha256: "b".repeat(64),
    provenanceUrl,
  })
  const publications = Object.fromEntries(
    Object.entries(plan.members)
      .filter(([name]) => name !== "mentraos")
      .map(([name, member]) => [
        name,
        Object.fromEntries(
          member.publishTargets.map((target) => [
            target,
            publication(
              target === "npm"
                ? `${name}@${plan.releaseIdentity}`
                : target === "maven-central"
                  ? `com.mentraglass:bluetooth-sdk:${plan.releaseIdentity}`
                  : `Mentra-Community/mentra-bluetooth-sdk-ios@${plan.releaseIdentity}`,
            ),
          ]),
        ),
      ]),
  )
  const runtimeImage = runtimeImageRecordForPlan(plan)
  const workspaceOrigin = "https://enterprisedev.mentraglass.com"
  const coreHostname = "ca-mentra-ent-ref-core.gentlehill-4ed63a4c.westus2.azurecontainerapps.io"
  const coreOrigin = `https://${coreHostname}`
  const privateDeployment = createPrivateDeploymentRecord({
    plan,
    sourceCommit: plan.sourceCommit,
    requestedTag: plan.sourceCommit,
    status: "deployed",
    sourceImage: runtimeImage.image,
    sourceImageDigest: runtimeImage.digest,
    image: `mentraenterpriseref.azurecr.io/mentra-cloud-enterprise@${runtimeImage.digest}`,
    imageDigest: runtimeImage.digest,
    revision: "ca-mentra-enterprise-reference--0000226",
    coreRevision: "ca-mentra-ent-ref-core--0000226",
    workspaceOrigin,
    coreHostname,
    coreOrigin,
    checks: [workspaceOrigin, coreOrigin].flatMap((origin) =>
      ["healthz", "ready"].map((probe) => ({url: `${origin}/${probe}`, ready: true, statusCode: 200})),
    ),
    completedAt: "2026-09-12T20:00:00.000Z",
    provenanceUrl,
  })
  const results = {
    releaseSetId: plan.releaseSetId,
    publications: {...publications, ...mobile.publications},
    artifacts: [
      ...mobile.artifacts,
      ...["asgSelection", "otaBundle", "enginePackage"].map((key) => publication(plan.artifactNames[key])),
    ],
    otaManifest: publication(plan.artifactNames.otaManifest),
    cloud: cloudRecordForPlan(plan),
    runtimeImage,
    privateDeployment,
  }
  const manifest = finalizeReleaseManifest({plan, results, completedAt: "2026-09-12T20:01:00.000Z"})
  assert.equal(manifest.publications.mentraos["google-play"], undefined)
  assert.equal(manifest.publications.mentraos["app-store-connect"].status, "published")
  assert.ok(manifest.artifacts.some((artifact) => artifact.coordinate === plan.artifactNames.androidApp))
  const missingApk = {
    ...results,
    artifacts: results.artifacts.filter((artifact) => artifact.coordinate !== plan.artifactNames.androidApp),
  }
  assert.throws(
    () => finalizeReleaseManifest({plan, results: missingApk, completedAt: "2026-09-12T20:01:00.000Z"}),
    /Missing required artifact/,
  )
})

test("beta, production and legacy dev plans retain their Play publication requirements", () => {
  for (const channel of ["dev", "beta", "production"]) {
    const args = {...input, channel, sequence: channel === "production" ? undefined : input.sequence}
    const plan = createReleasePlan(args)
    assert.ok(plan.members.mentraos.publishTargets.includes("google-play"))
    assert.notEqual(plan.native.googlePlayUpload, false)
    if (channel !== "dev")
      assert.throws(() => createReleasePlan({...args, uploadGooglePlay: false}), /only be disabled for dev/)
  }
})

test("the mobile workflow gates only Play operations, preserving Android artifacts and production promotion", () => {
  const workflow = readFileSync(new URL("../workflows/reusable-coordinated-mobile.yml", import.meta.url), "utf8")
  for (const name of [
    "Prepare Google Play upload tooling",
    "Install Google Play upload tooling",
    "Check selected Google Play track",
    "Upload exact AAB to Google Play",
    "Upload exact AAB to Google Play Internal App Sharing",
  ]) {
    const block = workflow.split(`      - name: ${name}\n`)[1].split("\n      - ")[0]
    assert.match(block, /if: .*needs.prepare.outputs.upload_google_play == 'true'/)
  }
  for (const name of [
    "Build signed coordinated APK and AAB",
    "Publish immutable Android release assets",
    "Write Android release result",
  ]) {
    const block = workflow.split(`      - name: ${name}\n`)[1].split("\n      - ")[0]
    assert.doesNotMatch(block, /if: .*upload_google_play/)
  }
  // Production candidates land on the production track as a draft (see the
  // family build numbers spec, "Google Play track floors"); submission verifies
  // that draft instead of promoting from a testing track.
  const production = readFileSync(new URL("../workflows/production-release-mobile.yml", import.meta.url), "utf8")
  assert.match(production, /play_track: production/)
  assert.match(production, /play_release_status: draft/)
  const submission = readFileSync(new URL("../workflows/production-release-store-submit.yml", import.meta.url), "utf8")
  assert.match(submission, /--required-state submitted/)
  assert.doesNotMatch(submission, /GOOGLE_PLAY_SOURCE_TRACK/)
})

// The pause is decided at the CLI boundary, where the coordinator's plan job
// calls the script; the library default is to upload.
test("the plan CLI pauses Google Play for dev and keeps it for staging", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-play-pause-cli-"))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
  const otaInputs = path.join(root, "ota-inputs.json")
  const collected = spawnSync(
    process.execPath,
    [".github/scripts/collect-ota-release-inputs.mjs", "asg_client/ota_manifests/firmware_live.json", otaInputs],
    {cwd: repositoryRoot, encoding: "utf8"},
  )
  assert.equal(collected.status, 0, collected.stderr)
  const planFor = (branch) => {
    const output = path.join(root, `${branch}.json`)
    const result = spawnSync(
      process.execPath,
      [
        ".github/scripts/create-release-plan.mjs",
        "--branch",
        branch,
        "--sequence",
        "1",
        "--source-commit",
        "a".repeat(40),
        "--native-build-sequence",
        "1",
        "--ota-inputs",
        otaInputs,
        "--output",
        output,
      ],
      {cwd: repositoryRoot, encoding: "utf8"},
    )
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(readFileSync(output, "utf8"))
  }
  const dev = planFor("dev")
  assert.equal(dev.native.googlePlayUpload, false)
  assert.deepEqual(dev.members.mentraos.publishTargets, ["app-store-connect"])
  const staging = planFor("staging")
  assert.equal(staging.native.googlePlayUpload, undefined)
  assert.ok(staging.members.mentraos.publishTargets.includes("google-play"))
})
