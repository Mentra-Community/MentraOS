import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {createProductionPromotionRecords} from "./create-production-promotion-records.mjs"

const root = mkdtempSync(path.join(tmpdir(), "production-promotion-"))
const files = Object.fromEntries(
  ["apk", "aab", "ipa"].map((name) => {
    const file = path.join(root, name)
    writeFileSync(file, `${name} bytes`)
    return [name, file]
  }),
)

function selected(file, coordinate) {
  const bytes = Buffer.from(`${path.basename(file)} bytes`)
  return {
    status: "published",
    coordinate,
    url: `https://example.com/${coordinate}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    provenanceUrl: "https://example.com/beta-run",
  }
}

const plan = {
  releaseSetId: "mentra-3.1.0",
  releaseIdentity: "3.1.0",
  familyBaseVersion: "3.1.0",
  channel: "production",
  sourceCommit: "a".repeat(40),
  native: {marketingVersion: "3.1.0", buildNumber: 310000057},
}
const selection = {
  releaseSetId: plan.releaseSetId,
  selectedBetaReleaseSetId: "mentra-3.1.0-beta.57",
  selectedBetaIdentity: "3.1.0-beta.57",
  sourceCommit: plan.sourceCommit,
  native: plan.native,
  betaManifest: {url: "https://example.com/beta.json", sha256: "b".repeat(64)},
  otaManifest: selected(files.apk, "ota.json"),
  otaArtifacts: [selected(files.apk, "ota.zip"), selected(files.apk, "asg.apk")],
  mobileArtifacts: {
    androidApk: selected(files.apk, "app.apk"),
    androidAab: selected(files.aab, "app.aab"),
    iosIpa: selected(files.ipa, "app.ipa"),
  },
}

test("records exact beta mobile and OTA bytes as production promotions", () => {
  const result = createProductionPromotionRecords({
    plan,
    selection,
    apk: files.apk,
    aab: files.aab,
    ipa: files.ipa,
    provenanceUrl: "https://example.com/promotion-run",
  })
  assert.equal(result.publications.mentraos["google-play"].status, "promoted")
  assert.equal(result.publications.mentraos["app-store-connect"].sha256, selection.mobileArtifacts.iosIpa.sha256)
  assert.equal(result.otaManifest.url, selection.otaManifest.url)
  assert.equal(result.artifacts.length, 5)
})

test("rejects substituted mobile bytes", () => {
  writeFileSync(files.apk, "substituted")
  assert.throws(
    () =>
      createProductionPromotionRecords({
        plan,
        selection,
        apk: files.apk,
        aab: files.aab,
        ipa: files.ipa,
        provenanceUrl: "https://example.com/promotion-run",
      }),
    /differs from the selected beta artifact/,
  )
  writeFileSync(files.apk, "apk bytes")
})
