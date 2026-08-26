import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {assembleCoordinatedReleaseResults} from "./assemble-coordinated-release-results.mjs"
import {createReleasePlan, finalizeReleaseManifest, loadReleaseFamily} from "./release-family.mjs"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const plan = createReleasePlan({
  family: loadReleaseFamily({rootDir}),
  channel: "beta",
  sequence: 57,
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: 310000057,
})
const provenanceUrl = "https://github.com/Mentra-Community/MentraOS/actions/runs/123"

function publication(coordinate, sha256 = "b".repeat(64)) {
  return {
    status: "published",
    coordinate,
    url: `https://example.com/${encodeURIComponent(coordinate)}`,
    sha256,
    provenanceUrl,
  }
}

function npmRecord(names) {
  return {
    releaseSetId: plan.releaseSetId,
    publications: Object.fromEntries(
      names.map((name) => [name, {npm: publication(`${name}@${plan.releaseIdentity}`)}]),
    ),
  }
}

test("assembles every product target and finalizes one complete release manifest", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "coordinated-results-"))
  const enginePackage = path.join(directory, plan.artifactNames.enginePackage)
  const asgSelectionFile = path.join(directory, plan.artifactNames.asgSelection)
  writeFileSync(enginePackage, "engine package")
  const asgSelection = {
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    sourceCommit: plan.sourceCommit,
    fingerprint: "f".repeat(64),
    versionCode: 100057,
    versionName: "asg.100057.ffffffffffff",
    apk: {asset: "mentra-live-asg.apk", sha256: "e".repeat(64)},
  }
  writeFileSync(asgSelectionFile, JSON.stringify(asgSelection))
  const selectionSha = createHash("sha256").update(JSON.stringify(asgSelection)).digest("hex")
  const engineSha = createHash("sha256").update("engine package").digest("hex")
  const npmRecordForFamily = npmRecord([
    "@mentra/jspolyfill",
    "@mentra/cloud-protocol",
    "@mentra/crust",
    "@mentra/cloud-client",
    "@mentra/bluetooth-sdk",
    "@mentra/miniapp",
    "@mentra/engine",
  ])
  npmRecordForFamily.publications["@mentra/engine"].npm = publication(
    `@mentra/engine@${plan.releaseIdentity}`,
    engineSha,
  )
  const npmRecords = [npmRecordForFamily]
  const native = {
    releaseSetId: plan.releaseSetId,
    publications: {
      "@mentra/bluetooth-sdk": {
        "maven-central": publication(`com.mentraglass:bluetooth-sdk:${plan.releaseIdentity}`),
        "swift-package-manager": publication(`Mentra-Community/mentra-bluetooth-sdk-ios@${plan.releaseIdentity}`),
      },
    },
    artifacts: [publication(`com.mentraglass:lc3Lib:${plan.releaseIdentity}`)],
  }
  const mobile = {
    releaseSetId: plan.releaseSetId,
    publications: {
      mentraos: {
        "google-play": publication(`com.mentra.mentra:${plan.native.buildNumber}:beta`),
        "app-store-connect": publication(
          `com.mentra.mentra:${plan.native.marketingVersion}:${plan.native.buildNumber}:Mentra Staging`,
        ),
      },
    },
    artifacts: [
      publication(plan.artifactNames.androidApp),
      publication(plan.artifactNames.androidStoreApp),
      publication(plan.artifactNames.iosApp),
    ],
  }
  const ota = {
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    sourceCommit: plan.sourceCommit,
    selection: {
      status: "published",
      asset: plan.artifactNames.asgSelection,
      url: "https://example.com/asg-selection.json",
      sha256: selectionSha,
      size: Buffer.byteLength(JSON.stringify(asgSelection)),
    },
    manifest: {
      status: "published",
      asset: plan.artifactNames.otaManifest,
      url: "https://example.com/ota.json",
      sha256: "c".repeat(64),
      size: 100,
    },
    bundle: {
      status: "published",
      asset: plan.artifactNames.otaBundle,
      url: "https://example.com/ota.zip",
      sha256: "d".repeat(64),
      size: 200,
    },
    asg: {
      fingerprint: asgSelection.fingerprint,
      versionCode: asgSelection.versionCode,
      versionName: asgSelection.versionName,
      reused: false,
      artifact: {
        asset: "mentra-live-asg.apk",
        url: "https://example.com/asg.apk",
        sha256: "e".repeat(64),
        size: 300,
        signingCertificateSha256: "f".repeat(64),
      },
    },
    workflow: {repository: "Mentra-Community/MentraOS", runId: "123"},
  }

  const results = assembleCoordinatedReleaseResults({
    plan,
    ota,
    npmRecords,
    native,
    mobile,
    asgSelectionFile,
    enginePackage,
    releaseAssetBaseUrl: `https://github.com/Mentra-Community/MentraOS/releases/download/mentra-v${plan.releaseIdentity}`,
  })
  const manifest = finalizeReleaseManifest({plan, results, completedAt: "2026-08-25T02:00:00.000Z"})

  assert.equal(Object.keys(manifest.publications).length, 8)
  assert.equal(manifest.publications["@mentra/bluetooth-sdk"]["maven-central"].status, "published")
  assert.equal(manifest.publications.mentraos["app-store-connect"].status, "published")
  assert.ok(manifest.artifacts.some((artifact) => artifact.coordinate === plan.artifactNames.asgSelection))
  assert.equal(manifest.artifacts.at(-1).coordinate, plan.artifactNames.enginePackage)

  assert.throws(
    () =>
      assembleCoordinatedReleaseResults({
        plan,
        ota,
        npmRecords: [...npmRecords, npmRecords[0]],
        native,
        mobile,
        asgSelectionFile,
        enginePackage,
        releaseAssetBaseUrl: "https://example.com/release",
      }),
    /Duplicate publication record/,
  )

  writeFileSync(asgSelectionFile, `${JSON.stringify(asgSelection)}\n`)
  assert.throws(
    () =>
      assembleCoordinatedReleaseResults({
        plan,
        ota,
        npmRecords,
        native,
        mobile,
        asgSelectionFile,
        enginePackage,
        releaseAssetBaseUrl: "https://example.com/release",
      }),
    /selection file differs/,
  )
})
