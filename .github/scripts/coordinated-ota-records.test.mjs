import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createAsgProvenance,
  createAsgSelection,
  createOtaReleaseResult,
  verifyAsgProvenance,
} from "./coordinated-ota-records.mjs"
import {serializeReleaseRecord} from "./release-family.mjs"

const signingCertificateSha256 = "e8f49381d6324f0703d464328a46eaba1f40422be3b39085d521e38885677387"
const identity = {
  schemaVersion: 1,
  fingerprint: "a".repeat(64),
  versionCode: 46_410_400,
  versionName: "asg.46410400.aaaaaaaaaaaa",
  apkAsset: `mentra-live-asg-46410400-${"a".repeat(64)}.apk`,
  provenanceAsset: `mentra-live-asg-46410400-${"a".repeat(64)}.json`,
  latestInputCommitTimestamp: 1_782_000_000,
  contract: {androidBuildVariant: "release"},
  entries: [{mode: "100644", object: "b".repeat(40), path: "asg_client/app/build.gradle"}],
}
const releasePlan = {
  releaseSetId: "mentra-3.1.0-beta.57",
  releaseIdentity: "3.1.0-beta.57",
  sourceCommit: "c".repeat(40),
  artifactNames: {
    otaManifest: "mentra-live-ota-3.1.0-beta.57.json",
    asgSelection: "mentra-live-asg-selection-3.1.0-beta.57.json",
  },
  otaInputs: {
    firmwareManifest: {path: "asg_client/ota_manifests/firmware_live.json", sha256: "d".repeat(64)},
    mtkPatches: [{start_firmware: "20260709", end_firmware: "20260730", url: "https://example.com/mtk.zip"}],
    mtkFullOta: {
      end_firmware: "20260730",
      url: "https://example.com/full.zip",
      sha256: "f".repeat(64),
      size: 640341205,
    },
    besFirmware: {version: "26.8.1", url: "https://example.com/bes.bin"},
  },
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "coordinated-ota-records-"))
  mkdirSync(path.join(root, "artifacts"))
  const apkPath = path.join(root, "artifacts", identity.apkAsset)
  const bundlePath = path.join(root, "artifacts", "mentra-live-ota-bundle-3.1.0-beta.57.zip")
  const manifestPath = path.join(root, "artifacts", releasePlan.artifactNames.otaManifest)
  const selectionPath = path.join(root, "artifacts", releasePlan.artifactNames.asgSelection)
  writeFileSync(apkPath, "signed apk fixture")
  writeFileSync(bundlePath, "portable OTA bundle fixture")
  const provenance = createAsgProvenance({
    identity,
    releasePlan,
    apkPath,
    apkUrl: `https://github.com/Mentra-Community/MentraOS/releases/download/mentra-coordinated-asg/${identity.apkAsset}`,
    signingCertificateSha256,
  })
  writeFileSync(selectionPath, serializeReleaseRecord(createAsgSelection({releasePlan, identity, provenance})))
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        releaseVersion: releasePlan.releaseIdentity,
        apps: {
          "com.mentra.asg_client": {
            versionCode: identity.versionCode,
            versionName: identity.versionName,
            apkUrl: provenance.apk.url,
            apkSize: provenance.apk.size,
            sha256: provenance.apk.sha256,
          },
        },
        mtk_patches: releasePlan.otaInputs.mtkPatches,
        mtk_full_ota: releasePlan.otaInputs.mtkFullOta,
        bes_firmware: releasePlan.otaInputs.besFirmware,
      },
      null,
      2,
    )}\n`,
  )
  return {apkPath, bundlePath, manifestPath, selectionPath, provenance}
}

function prepareWorkflowNames(fixtureData, reused) {
  const root = path.dirname(path.dirname(fixtureData.apkPath))
  mkdirSync(path.join(root, "release-intent"))
  mkdirSync(path.join(root, "coordinated-ota-work"))
  writeFileSync(
    path.join(root, "release-intent/release-plan.json"),
    JSON.stringify({
      ...releasePlan,
      artifactContainerTag: "mentra-builds-v3.1.0",
      artifactNames: {...releasePlan.artifactNames, otaBundle: path.basename(fixtureData.bundlePath)},
    }),
  )
  writeFileSync(path.join(root, "coordinated-ota-work/asg-build-identity.json"), JSON.stringify(identity))
  writeFileSync(path.join(root, "coordinated-ota-work/asg-provenance.json"), JSON.stringify(fixtureData.provenance))
  const workflow = readFileSync(new URL("../workflows/reusable-coordinated-ota.yml", import.meta.url), "utf8")
  const step = workflow.split("      - name: Prepare immutable asset names\n")[1].split("\n      - name:")[0]
  const script = step.split("        run: |\n")[1].replace(/^          /gm, "")
  const output = path.join(root, "output")
  execFileSync("bash", ["-c", script], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      REPOSITORY: "Mentra-Community/MentraOS",
      ASG_RELEASE_TAG: "mentra-coordinated-asg",
      ASG_REUSED: String(reused),
      EXPECTED_APK_ASSET: identity.apkAsset,
      EXPECTED_PROVENANCE_ASSET: identity.provenanceAsset,
    },
  })
  return Object.fromEntries(
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  )
}

test("creates and verifies immutable ASG provenance", () => {
  const fixtureData = fixture()
  assert.equal(
    verifyAsgProvenance({
      identity,
      provenance: fixtureData.provenance,
      apkPath: fixtureData.apkPath,
      signingCertificateSha256: signingCertificateSha256.toUpperCase().match(/../g).join(":"),
    }),
    fixtureData.provenance,
  )
})

test("creates a retry-stable ASG selection record", () => {
  const fixtureData = fixture()
  const selection = createAsgSelection({releasePlan, identity, provenance: fixtureData.provenance})

  assert.equal(selection.releaseSetId, releasePlan.releaseSetId)
  assert.equal(selection.fingerprint, identity.fingerprint)
  assert.equal(selection.originatingReleaseSetId, releasePlan.releaseSetId)
  assert.equal(Object.hasOwn(selection, "reused"), false)
})

test("rejects ASG bytes that differ from recorded provenance", () => {
  const fixtureData = fixture()
  writeFileSync(fixtureData.apkPath, "different bytes")
  assert.throws(
    () =>
      verifyAsgProvenance({
        identity,
        provenance: fixtureData.provenance,
        apkPath: fixtureData.apkPath,
        signingCertificateSha256,
      }),
    /SHA-256 does not match/,
  )
})

test("the OTA workflow reuses a historical GitHub APK URL through exact release-result validation", () => {
  const fixtureData = fixture()
  const outputs = prepareWorkflowNames(fixtureData, true)
  assert.equal(outputs.apk_url, fixtureData.provenance.apk.url)
  const manifest = JSON.parse(readFileSync(fixtureData.manifestPath, "utf8"))
  manifest.apps["com.mentra.asg_client"].apkUrl = outputs.apk_url
  writeFileSync(fixtureData.manifestPath, JSON.stringify(manifest))
  const result = createOtaReleaseResult({
    releasePlan,
    identity,
    provenance: fixtureData.provenance,
    selectionPath: fixtureData.selectionPath,
    selectionUrl: "https://example.com/asg-selection.json",
    selectionStatus: "published",
    manifestPath: fixtureData.manifestPath,
    manifestUrl: outputs.manifest_url,
    bundlePath: fixtureData.bundlePath,
    bundleUrl: outputs.bundle_url,
    bundleStatus: "published",
    manifestStatus: "reused",
    reused: true,
    workflow: {
      apkPath: fixtureData.apkPath,
      signingCertificateSha256,
      repository: "Mentra-Community/MentraOS",
      runId: "123",
      runAttempt: 2,
    },
  })

  assert.equal(result.asg.reused, true)
  assert.equal(result.selection.asset, releasePlan.artifactNames.asgSelection)
  assert.equal(result.manifest.status, "reused")
  assert.equal(result.bundle.status, "published")
  assert.equal(result.asg.originatingReleaseSetId, releasePlan.releaseSetId)
  assert.equal(result.firmwareManifestSha256, releasePlan.otaInputs.firmwareManifest.sha256)
  assert.match(result.manifest.sha256, /^[0-9a-f]{64}$/)
})

test("the OTA workflow assigns the CDN URL to a newly built ASG APK", () => {
  const outputs = prepareWorkflowNames(fixture(), false)
  assert.equal(
    outputs.apk_url,
    `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/mentra-coordinated-asg/${identity.apkAsset}`,
  )
})

test("rejects a manifest attributed to a different coordinated release", () => {
  const fixtureData = fixture()
  const manifest = JSON.parse(readFileSync(fixtureData.manifestPath, "utf8"))
  manifest.releaseVersion = "3.1.0-beta.56"
  writeFileSync(fixtureData.manifestPath, JSON.stringify(manifest))

  assert.throws(
    () =>
      createOtaReleaseResult({
        releasePlan,
        identity,
        provenance: fixtureData.provenance,
        selectionPath: fixtureData.selectionPath,
        selectionUrl: "https://example.com/asg-selection.json",
        selectionStatus: "published",
        manifestPath: fixtureData.manifestPath,
        manifestUrl: "https://example.com/version.json",
        bundlePath: fixtureData.bundlePath,
        bundleUrl: "https://example.com/bundle.zip",
        bundleStatus: "published",
        manifestStatus: "published",
        reused: false,
        workflow: {
          apkPath: fixtureData.apkPath,
          signingCertificateSha256,
          repository: "Mentra-Community/MentraOS",
          runId: "123",
          runAttempt: 1,
        },
      }),
    /does not identify the release/,
  )
})

test("rejects a substituted ASG selection record", () => {
  const fixtureData = fixture()
  const selection = JSON.parse(readFileSync(fixtureData.selectionPath, "utf8"))
  selection.versionCode += 1
  writeFileSync(fixtureData.selectionPath, JSON.stringify(selection))

  assert.throws(
    () =>
      createOtaReleaseResult({
        releasePlan,
        identity,
        provenance: fixtureData.provenance,
        selectionPath: fixtureData.selectionPath,
        selectionUrl: "https://example.com/asg-selection.json",
        selectionStatus: "published",
        manifestPath: fixtureData.manifestPath,
        manifestUrl: "https://example.com/version.json",
        bundlePath: fixtureData.bundlePath,
        bundleUrl: "https://example.com/bundle.zip",
        bundleStatus: "published",
        manifestStatus: "published",
        reused: false,
        workflow: {
          apkPath: fixtureData.apkPath,
          signingCertificateSha256,
          repository: "Mentra-Community/MentraOS",
          runId: "123",
          runAttempt: 1,
        },
      }),
    /selection record does not match/,
  )
})

test("compares promoted firmware semantically instead of by object key order", () => {
  const fixtureData = fixture()
  const manifest = JSON.parse(readFileSync(fixtureData.manifestPath, "utf8"))
  manifest.mtk_patches = manifest.mtk_patches.map((patch) => ({
    url: patch.url,
    end_firmware: patch.end_firmware,
    start_firmware: patch.start_firmware,
  }))
  manifest.bes_firmware = {url: manifest.bes_firmware.url, version: manifest.bes_firmware.version}
  writeFileSync(fixtureData.manifestPath, JSON.stringify(manifest))

  assert.doesNotThrow(() =>
    createOtaReleaseResult({
      releasePlan,
      identity,
      provenance: fixtureData.provenance,
      selectionPath: fixtureData.selectionPath,
      selectionUrl: "https://example.com/asg-selection.json",
      selectionStatus: "published",
      manifestPath: fixtureData.manifestPath,
      manifestUrl: "https://example.com/version.json",
      bundlePath: fixtureData.bundlePath,
      bundleUrl: "https://example.com/bundle.zip",
      bundleStatus: "published",
      manifestStatus: "published",
      reused: false,
      workflow: {
        apkPath: fixtureData.apkPath,
        signingCertificateSha256,
        repository: "Mentra-Community/MentraOS",
        runId: "123",
        runAttempt: 1,
      },
    }),
  )
})

for (const field of ["bes_firmware", "mtk_full_ota"]) {
test(`rejects a manifest whose ${field} differs from release intent`, () => {
  const fixtureData = fixture()
  const manifest = JSON.parse(readFileSync(fixtureData.manifestPath, "utf8"))
  manifest[field].url = "https://example.com/unexpected"
  writeFileSync(fixtureData.manifestPath, JSON.stringify(manifest))

  assert.throws(
    () =>
      createOtaReleaseResult({
        releasePlan,
        identity,
        provenance: fixtureData.provenance,
        selectionPath: fixtureData.selectionPath,
        selectionUrl: "https://example.com/asg-selection.json",
        selectionStatus: "published",
        manifestPath: fixtureData.manifestPath,
        manifestUrl: "https://example.com/version.json",
        bundlePath: fixtureData.bundlePath,
        bundleUrl: "https://example.com/bundle.zip",
        bundleStatus: "published",
        manifestStatus: "published",
        reused: false,
        workflow: {
          apkPath: fixtureData.apkPath,
          signingCertificateSha256,
          repository: "Mentra-Community/MentraOS",
          runId: "123",
          runAttempt: 1,
        },
      }),
    /(?:BES input|MTK full OTA) differs/,
  )
})
}
