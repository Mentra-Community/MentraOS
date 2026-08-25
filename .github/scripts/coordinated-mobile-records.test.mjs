import assert from "node:assert/strict"
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
  const base = "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-v3.1.0-beta.57"
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
    testflightGroup: "Beta",
    storeStatus: "reused",
    provenanceUrl,
  })
  const merged = mergeMobileRecords({plan, android, ios})

  assert.equal(merged.publications.mentraos["google-play"].coordinate, "com.mentra.mentra:310000057:beta")
  assert.equal(merged.publications.mentraos["app-store-connect"].status, "reused")
  assert.equal(merged.artifacts.length, 3)
})
