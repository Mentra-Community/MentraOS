import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {mkdtempSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {assembleCoordinatedReleaseResults} from "./assemble-coordinated-release-results.mjs"
import {cloudRecordForPlan} from "./coordinated-cloud-v2-test-helpers.mjs"
import {
  productionOtaArtifacts,
  productionOtaResult,
  productionOtaSources,
  promotedBetaUrls,
  promotedReleasePlan,
} from "./production-ota-assets.mjs"
import {
  createReleasePlan,
  familyBuildNumber,
  finalizeReleaseManifest,
  loadReleaseFamily,
  releaseRecordSha256,
} from "./release-family.mjs"

const repository = "Mentra-Community/MentraOS"
const family = loadReleaseFamily({rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")})
const base = family.familyBaseVersion
const betaIdentity = `${base}-beta.101`
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const provenanceUrl = "https://github.com/Mentra-Community/Mentra/actions/runs/123"

const betaPlan = createReleasePlan({
  family,
  channel: "beta",
  sequence: 101,
  sourceCommit: "b".repeat(40),
  nativeBuildNumber: familyBuildNumber(base, 101),
  otaInputs: {firmwareManifest: {sha256: "f".repeat(64)}},
})
const otaFiles = {otaManifest: Buffer.from("beta OTA manifest"), otaBundle: Buffer.from("beta OTA bundle")}
const betaRecord = {
  releaseSetId: betaPlan.releaseSetId,
  releaseIdentity: betaIdentity,
  familyBaseVersion: base,
  channel: "beta",
  sourceCommit: betaPlan.sourceCommit,
  completedAt: "2026-11-01T00:00:00.000Z",
  releasePlanSha256: releaseRecordSha256(betaPlan),
  otaManifest: {
    status: "published",
    coordinate: betaPlan.artifactNames.otaManifest,
    url: "https://example.com/ota.json",
    sha256: sha256(otaFiles.otaManifest),
    provenanceUrl,
  },
  artifacts: [
    {
      coordinate: betaPlan.artifactNames.otaBundle,
      url: "https://example.com/bundle.zip",
      sha256: sha256(otaFiles.otaBundle),
    },
  ],
}
const betaRecordUrl = "https://example.com/beta.json"
const betaRecordSha256 = "e".repeat(64)

function productionPlan() {
  return createReleasePlan({
    family,
    channel: "production",
    sourceCommit: "a".repeat(40),
    nativeBuildNumber: familyBuildNumber(base, 102),
  })
}

function promote(overrides = {}) {
  return promotedReleasePlan({
    plan: productionPlan(),
    betaIdentity,
    betaPlan,
    betaRecord,
    betaRecordUrl,
    betaRecordSha256,
    ...overrides,
  })
}

test("the promoted beta's files are read from its family container", () => {
  const urls = promotedBetaUrls({plan: productionPlan(), betaIdentity, repository})
  assert.match(urls.record, new RegExp(`/releases/mentra-builds-v${base}/mentra-release-${betaIdentity}\\.json$`))
  assert.match(urls.plan, new RegExp(`/releases/mentra-builds-v${base}/mentra-release-plan-${betaIdentity}\\.json$`))
  for (const other of ["", `${base}-dev.101`, "1.0.0-beta.1", `${base}-beta.0`]) {
    assert.throws(() => promotedBetaUrls({plan: productionPlan(), betaIdentity: other, repository}), /is not a beta of/)
  }
})

test("the production plan takes the promoted beta's OTA inputs and provenance", () => {
  const plan = promote()
  assert.deepEqual(plan.otaInputs, betaPlan.otaInputs)
  assert.deepEqual(plan.promotion, {
    selectedBetaReleaseSetId: betaPlan.releaseSetId,
    selectedBetaIdentity: betaIdentity,
    selectedBetaManifest: {url: betaRecordUrl, sha256: betaRecordSha256},
    otaManifest: betaRecord.otaManifest,
  })
  assert.throws(() => promotedReleasePlan({plan, betaIdentity, betaPlan, betaRecord, betaRecordUrl, betaRecordSha256}),
    /An unfilled production release plan is required/)
  assert.throws(() => promote({betaRecord: {...betaRecord, releasePlanSha256: "0".repeat(64)}}), /do not describe one beta/)
  assert.throws(() => promote({betaRecord: {...betaRecord, completedAt: undefined}}), /is not complete/)
  assert.throws(() => promote({betaIdentity: `${base}-beta.7`}), /do not describe one beta/)
})

test("a production release records the promoted OTA manifest and byte-identical copies", (t) => {
  const plan = promote()
  const sources = productionOtaSources({plan, betaManifest: betaRecord, betaManifestSha256: betaRecordSha256})
  const artifacts = productionOtaArtifacts({plan, sources, files: otaFiles, repository})
  const ota = productionOtaResult({plan, artifacts})
  assert.equal(ota.otaManifest.status, "promoted")
  assert.equal(ota.otaManifest.url, betaRecord.otaManifest.url)
  assert.throws(
    () => productionOtaArtifacts({plan, sources, files: {...otaFiles, otaBundle: Buffer.from("x")}, repository}),
    /is not a byte-identical copy/,
  )

  const directory = mkdtempSync(path.join(tmpdir(), "production-results-"))
  t.after(() => rmSync(directory, {recursive: true, force: true}))
  const enginePackage = path.join(directory, plan.artifactNames.enginePackage)
  writeFileSync(enginePackage, "engine package")
  const publication = (coordinate, digest = "c".repeat(64)) => ({
    status: "published",
    coordinate,
    url: `https://example.com/${encodeURIComponent(coordinate)}`,
    sha256: digest,
    provenanceUrl,
  })
  const npm = {
    releaseSetId: plan.releaseSetId,
    publications: Object.fromEntries(
      Object.entries(plan.members)
        .filter(([, member]) => member.publishTargets.includes("npm"))
        .map(([name]) => [
          name,
          {npm: publication(`${name}@${base}`, name === "@mentra/engine" ? sha256("engine package") : undefined)},
        ]),
    ),
  }
  const native = {
    releaseSetId: plan.releaseSetId,
    publications: {
      "@mentra/bluetooth-sdk": {
        "maven-central": publication(`com.mentraglass:bluetooth-sdk:${base}`),
        "swift-package-manager": publication(`Mentra-Community/mentra-bluetooth-sdk-ios@${base}`),
      },
    },
    artifacts: [],
  }
  const mobile = {
    releaseSetId: plan.releaseSetId,
    publications: {
      mentraos: {
        "google-play": publication(`com.mentra.mentra:${plan.native.buildNumber}:production`),
        "app-store-connect": publication(`com.mentra.mentra:${base}:${plan.native.buildNumber}:App Store`),
      },
    },
    artifacts: [],
  }
  const results = assembleCoordinatedReleaseResults({
    plan,
    ota,
    npmRecords: [npm],
    native,
    mobile,
    cloud: cloudRecordForPlan(plan),
    enginePackage,
    releaseAssetBaseUrl: `https://artifactscdn.mentraglass.com/${repository}/releases/${plan.artifactContainerTag}`,
  })
  const manifest = finalizeReleaseManifest({plan, results, completedAt: "2026-11-06T00:00:00.000Z"})
  assert.equal(manifest.channel, "production")
  assert.equal(manifest.releaseIdentity, base)
  assert.equal(manifest.otaManifest.status, "promoted")
  assert.equal(manifest.cloud.environment, "prod")
  assert.equal(manifest.promotion.selectedBetaIdentity, betaIdentity)
  assert.deepEqual(
    manifest.artifacts.map(({coordinate}) => coordinate),
    [plan.artifactNames.otaManifest, plan.artifactNames.otaBundle, plan.artifactNames.enginePackage],
  )
  assert.equal(manifest.runtimeImage, undefined)
  assert.throws(
    () => finalizeReleaseManifest({plan, results: {...results, otaManifest: betaRecord.otaManifest}, completedAt: manifest.completedAt}),
    /must be promoted/,
  )
})
