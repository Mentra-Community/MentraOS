import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {assembleProductionReleaseResults} from "./assemble-production-release-results.mjs"
import {createReleasePlan, finalizeReleaseManifest, loadReleaseFamily} from "./release-family.mjs"

const plan = createReleasePlan({
  family: loadReleaseFamily({rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")}),
  channel: "production",
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: 310000057,
})
plan.promotion = {
  selectedBetaReleaseSetId: "mentra-3.1.0-beta.57",
  selectedBetaIdentity: "3.1.0-beta.57",
  selectedBetaManifest: {url: "https://example.com/beta.json", sha256: "b".repeat(64)},
}
const provenanceUrl = "https://github.com/Mentra-Community/MentraOS/actions/runs/456"

function publication(coordinate, sha256 = "c".repeat(64)) {
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

test("assembles stable packages with exact promoted beta mobile and OTA bytes", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "production-results-"))
  const enginePackage = path.join(directory, plan.artifactNames.enginePackage)
  writeFileSync(enginePackage, "stable engine package")
  const engineSha = createHash("sha256").update("stable engine package").digest("hex")
  const npmRecordForFamily = npmRecord([
    "@mentra/jspolyfill",
    "@mentra/cloud-protocol",
    "@mentra/crust",
    "@mentra/cloud-client",
    "@mentra/bluetooth-sdk",
    "@mentra/types",
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
  }
  const promotion = {
    releaseSetId: plan.releaseSetId,
    promotion: plan.promotion,
    publications: {
      mentraos: {
        "google-play": {
          ...publication(`com.mentra.mentra:${plan.native.buildNumber}:production`),
          status: "promoted",
        },
        "app-store-connect": {
          ...publication(`com.mentra.mentra:${plan.native.marketingVersion}:${plan.native.buildNumber}:App Store`),
          status: "promoted",
        },
      },
    },
    otaManifest: {...publication("mentra-live-ota-3.1.0-beta.57.json"), status: "promoted"},
    artifacts: [
      {...publication("mentraos-3.1.0-beta.57-android.apk"), status: "promoted"},
      {...publication("mentraos-3.1.0-beta.57-android.aab"), status: "promoted"},
      {...publication("mentraos-3.1.0-beta.57-ios.ipa"), status: "promoted"},
      {...publication("mentra-live-asg-selection-3.1.0-beta.57.json"), status: "promoted"},
      {...publication("mentra-live-ota-bundle-3.1.0-beta.57.zip"), status: "promoted"},
      {...publication("mentra-live-asg-100057.apk"), status: "promoted"},
    ],
  }
  const results = assembleProductionReleaseResults({
    plan,
    npmRecords,
    native,
    promotion,
    enginePackage,
    assetBaseUrl: "https://example.com/stable",
  })
  const manifest = finalizeReleaseManifest({plan, results, completedAt: "2026-08-25T03:00:00.000Z"})
  assert.equal(manifest.releaseIdentity, "3.1.0")
  assert.equal(manifest.promotion.selectedBetaIdentity, "3.1.0-beta.57")
  assert.equal(manifest.publications.mentraos["google-play"].status, "promoted")
  assert.equal(manifest.otaManifest.coordinate, "mentra-live-ota-3.1.0-beta.57.json")

  results.otaManifest.status = "published"
  assert.throws(
    () => finalizeReleaseManifest({plan, results, completedAt: "2026-08-25T03:00:00.000Z"}),
    /must be promoted from the selected beta/,
  )
})
