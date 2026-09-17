import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {createAndroidRecord, createIosRecord, mergeMobileRecords} from "./coordinated-mobile-records.mjs"

const plan = {
  familyBaseVersion: "3.1.0",
  releaseIdentity: "3.1.0-beta.57",
  releaseSetId: "mentra-3.1.0-beta.57",
  native: {marketingVersion: "3.1.0", buildNumber: 310000057},
  members: {mentraos: {version: "3.1.0-beta.57"}},
  artifactNames: {
    androidApp: "mentraos-3.1.0-beta.57-android.apk",
    androidStoreApp: "mentraos-3.1.0-beta.57-android.aab",
    iosApp: "mentraos-3.1.0-beta.57-ios.ipa",
  },
}

test("records and merges exact mobile store and downloadable artifacts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "coordinated-mobile-records-"))
  const apk = path.join(root, "app.apk")
  const aab = path.join(root, "app.aab")
  const ipa = path.join(root, "app.ipa")
  writeFileSync(apk, "apk")
  writeFileSync(aab, "aab")
  writeFileSync(ipa, "ipa")
  const base = "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-builds-v3.1.0"
  const provenanceUrl = "https://github.com/Mentra-Community/MentraOS/actions/runs/123"
  const android = createAndroidRecord({
    plan,
    apk,
    apkUrl: `${base}/${plan.artifactNames.androidApp}`,
    aab,
    aabUrl: `${base}/${plan.artifactNames.androidStoreApp}`,
    playTrack: "beta",
    storeStatus: "published",
    provenanceUrl,
  })
  const ios = createIosRecord({
    plan,
    ipa,
    ipaUrl: `${base}/${plan.artifactNames.iosApp}`,
    testflightGroup: "Mentra Staging",
    storeStatus: "reused",
    provenanceUrl,
  })
  const merged = mergeMobileRecords({plan, android, ios})

  assert.equal(merged.publications.mentraos["google-play"].coordinate, "com.mentra.mentra:310000057:beta")
  assert.equal(merged.publications.mentraos["app-store-connect"].status, "reused")
  assert.equal(merged.artifacts.length, 3)
  const publicPlan = {
    ...plan,
    channel: "beta",
    native: {...plan.native, testflight: {group: "Mentra Staging Public", audience: "external"}},
  }
  const publicInput = {
    plan: publicPlan,
    ipa,
    ipaUrl: `${base}/${plan.artifactNames.iosApp}`,
    testflightGroup: "Mentra Staging Public",
    storeStatus: "published",
    provenanceUrl,
  }
  assert.throws(() => createIosRecord(publicInput), /distribution evidence/)
  const publicIos = createIosRecord({
    ...publicInput,
    testflight: {
      group: "Mentra Staging Public",
      audience: "external",
      buildId: "build-1",
      status: "skipped",
      installUrl: "https://testflight.apple.com/join/public123",
      skipReason: "external_review_pending",
      reviewState: "IN_REVIEW",
    },
  })
  const publicMerged = mergeMobileRecords({plan: publicPlan, android, ios: publicIos})
  assert.equal(publicMerged.publications.mentraos["app-store-connect"].testflight.status, "skipped")
  assert.doesNotThrow(() => createIosRecord({...publicInput, storeStatus: "built"}))
})

test("Internal App Sharing publications carry the Play download link for the exact AAB", () => {
  const root = mkdtempSync(path.join(tmpdir(), "coordinated-mobile-records-sharing-"))
  const apk = path.join(root, "app.apk")
  const aab = path.join(root, "app.aab")
  writeFileSync(apk, "apk")
  writeFileSync(aab, "aab")
  const base = "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-builds-v3.1.0"
  const input = {
    plan,
    apk,
    apkUrl: `${base}/${plan.artifactNames.androidApp}`,
    aab,
    aabUrl: `${base}/${plan.artifactNames.androidStoreApp}`,
    playTrack: "internal-app-sharing",
    storeStatus: "published",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123",
  }
  const aabSha256 = createHash("sha256").update("aab").digest("hex")
  const internalSharing = {
    downloadUrl: "https://play.google.com/apps/test/com.mentra.mentra/42",
    sha256: aabSha256,
    certificateFingerprint: "AA:BB",
  }
  const record = createAndroidRecord({...input, internalSharing})
  const google = record.publications.mentraos["google-play"]
  assert.equal(google.coordinate, "com.mentra.mentra:310000057:internal-app-sharing")
  assert.equal(google.url, internalSharing.downloadUrl)
  assert.equal(google.sha256, aabSha256)
  assert.deepEqual(google.playArtifact, {sha256: aabSha256, certificateFingerprint: "AA:BB"})
  // Play's digest describes the artifact it generated; a different value is kept, not refused.
  const generated = createAndroidRecord({...input, internalSharing: {...internalSharing, sha256: "0".repeat(64)}})
  assert.equal(generated.publications.mentraos["google-play"].playArtifact.sha256, "0".repeat(64))
  assert.throws(() => createAndroidRecord(input), /no HTTPS download URL/)
  assert.throws(() => createAndroidRecord({...input, playTrack: "production", internalSharing}), /does not belong/)
  const dryRun = createAndroidRecord({...input, storeStatus: "built"})
  assert.equal(dryRun.publications.mentraos["google-play"].url, "https://play.google.com/console/")
  assert.equal(dryRun.publications.mentraos["google-play"].playArtifact, undefined)
})
