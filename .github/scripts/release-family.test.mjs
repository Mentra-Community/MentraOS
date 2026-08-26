import assert from "node:assert/strict"
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  channelForBranch,
  createReleasePlan,
  dependencyOrder,
  deriveReleaseIdentity,
  finalizeReleaseManifest,
  loadReleaseFamily,
  releaseRecordSha256,
  requirePublicHttpsUrl,
  serializeReleaseRecord,
} from "./release-family.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function writeChangelog(root, version = "3.1.0") {
  mkdirSync(path.join(root, "changelogs"), {recursive: true})
  writeFileSync(path.join(root, "changelogs", version + ".md"), "Release notes")
}

test("accepts only credential-free public HTTPS URLs without fragments", () => {
  assert.equal(
    requirePublicHttpsUrl("https://artifacts.example.com/file?q=1", "artifact"),
    "https://artifacts.example.com/file?q=1",
  )
  assert.throws(() => requirePublicHttpsUrl("http://artifacts.example.com/file", "artifact"), /must use HTTPS/)
  assert.throws(
    () => requirePublicHttpsUrl("https://token@artifacts.example.com/file", "artifact"),
    /credential-free HTTPS/,
  )
  assert.throws(
    () => requirePublicHttpsUrl("https://artifacts.example.com/file#sha256", "artifact"),
    /without a fragment/,
  )
})

test("loads the repository release family and derives dependency-first publication order", () => {
  const family = loadReleaseFamily({rootDir: repositoryRoot})

  assert.equal(family.familyBaseVersion, "3.1.0")
  assert.deepEqual(family.products, ["mentraos", "@mentra/engine", "@mentra/bluetooth-sdk"])
  assert.equal(family.members.length, 8)
  assert.ok(family.publicationOrder.indexOf("@mentra/jspolyfill") < family.publicationOrder.indexOf("@mentra/crust"))
  assert.ok(
    family.publicationOrder.indexOf("@mentra/bluetooth-sdk") < family.publicationOrder.indexOf("@mentra/engine"),
  )
  assert.equal(
    family.members.some((member) => member.name === "@mentra/types"),
    false,
  )
  assert.ok(family.publicationOrder.indexOf("@mentra/engine") < family.publicationOrder.indexOf("mentraos"))
})

test("requires release notes for the active family base version", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-release-family-"))
  mkdirSync(path.join(root, ".github"), {recursive: true})
  writeFileSync(path.join(root, "package.json"), JSON.stringify({name: "product", version: "3.1.0"}))
  writeFileSync(
    path.join(root, ".github/release-family.json"),
    JSON.stringify({
      schemaVersion: 1,
      family: "mentra",
      versionSource: "package.json",
      products: ["product"],
      members: [
        {
          name: "product",
          manifest: "package.json",
          kind: "product",
          publishTargets: ["npm"],
          dependencies: [],
        },
      ],
    }),
  )

  assert.throws(() => loadReleaseFamily({rootDir: root}), /missing changelogs\/3\.1\.0\.md/)
})

test("maps release branches and derives one ecosystem-neutral identity", () => {
  assert.equal(channelForBranch("dev"), "dev")
  assert.equal(channelForBranch("staging"), "beta")
  assert.equal(channelForBranch("main"), "production")
  assert.equal(deriveReleaseIdentity("3.1.0", "dev", 184), "3.1.0-dev.184")
  assert.equal(deriveReleaseIdentity("3.1.0", "beta", 57), "3.1.0-beta.57")
  assert.equal(deriveReleaseIdentity("3.1.0", "production"), "3.1.0")
  assert.throws(() => channelForBranch("feature/example"), /not a coordinated release branch/)
  assert.throws(() => deriveReleaseIdentity("3.1.0", "beta", 0), /positive safe integer/)
  assert.throws(() => deriveReleaseIdentity("3.1.0-beta.1", "beta", 2), /plain X.Y.Z/)
})

test("creates a deterministic release plan with exact dependency versions", () => {
  const family = loadReleaseFamily({rootDir: repositoryRoot})
  const plan = createReleasePlan({
    family,
    channel: "beta",
    sequence: 57,
    sourceCommit: "a".repeat(40),
    nativeBuildNumber: 3100057,
    otaInputs: {firmwareManifest: "firmware_live.json"},
  })

  assert.equal(plan.releaseSetId, "mentra-3.1.0-beta.57")
  assert.equal(plan.native.marketingVersion, "3.1.0")
  assert.equal(plan.native.buildNumber, 3100057)
  assert.equal(plan.products["@mentra/engine"], "3.1.0-beta.57")
  assert.equal(plan.members["@mentra/engine"].dependencies["@mentra/bluetooth-sdk"], "3.1.0-beta.57")
  assert.equal(plan.members["@mentra/bluetooth-sdk"].publishTargets.length, 3)
  assert.equal(plan.artifactNames.otaManifest, "mentra-live-ota-3.1.0-beta.57.json")
  assert.equal(plan.artifactNames.otaBundle, "mentra-live-ota-bundle-3.1.0-beta.57.zip")
  assert.equal(plan.artifactNames.asgSelection, "mentra-live-asg-selection-3.1.0-beta.57.json")
  assert.equal(plan.artifactNames.androidStoreApp, "mentraos-3.1.0-beta.57-android.aab")
  assert.equal(plan.artifactNames.iosSdkArchive, "mentra-bluetooth-sdk-ios-3.1.0-beta.57.tar")
  assert.equal(plan.otaInputs.firmwareManifest, "firmware_live.json")
})

test("serializes records canonically and finalizes only complete release results", () => {
  const family = loadReleaseFamily({rootDir: repositoryRoot})
  const plan = createReleasePlan({
    family,
    channel: "beta",
    sequence: 57,
    sourceCommit: "a".repeat(40),
    nativeBuildNumber: 3100057,
  })
  const publication = (coordinate) => ({
    status: "published",
    coordinate,
    url: `https://artifacts.example.com/${encodeURIComponent(coordinate)}`,
    sha256: "b".repeat(64),
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/attestations/123",
  })
  const expectedCoordinates = {
    "npm": (name) => `${name}@${plan.releaseIdentity}`,
    "maven-central": () => `com.mentraglass:bluetooth-sdk:${plan.releaseIdentity}`,
    "swift-package-manager": () => `Mentra-Community/mentra-bluetooth-sdk-ios@${plan.releaseIdentity}`,
    "google-play": () => `com.mentra.mentra:${plan.native.buildNumber}:beta`,
    "app-store-connect": () =>
      `com.mentra.mentra:${plan.native.marketingVersion}:${plan.native.buildNumber}:Mentra Staging`,
  }
  const publications = Object.fromEntries(
    Object.entries(plan.members).map(([name, member]) => [
      name,
      Object.fromEntries(
        member.publishTargets.map((target) => [target, publication(expectedCoordinates[target](name))]),
      ),
    ]),
  )
  const results = {
    releaseSetId: plan.releaseSetId,
    publications,
    otaManifest: publication(plan.artifactNames.otaManifest),
    artifacts: [
      publication(plan.artifactNames.asgSelection),
      publication(plan.artifactNames.otaBundle),
      publication(plan.artifactNames.androidApp),
      publication(plan.artifactNames.androidStoreApp),
      publication(plan.artifactNames.iosApp),
      publication(plan.artifactNames.enginePackage),
    ],
  }

  const manifest = finalizeReleaseManifest({plan, results, completedAt: "2026-08-24T20:00:00.000Z"})
  assert.equal(manifest.releasePlanSha256, releaseRecordSha256(plan))
  assert.equal(manifest.publications["@mentra/engine"].npm.coordinate, "@mentra/engine@3.1.0-beta.57")
  assert.deepEqual(manifest.native, plan.native)
  assert.equal(serializeReleaseRecord({z: 1, a: 2}), '{\n  "a": 2,\n  "z": 1\n}\n')

  const incompletePlan = structuredClone(plan)
  delete incompletePlan.artifactNames.androidStoreApp
  assert.throws(
    () => finalizeReleaseManifest({plan: incompletePlan, results, completedAt: "2026-08-24T20:00:00.000Z"}),
    /missing required artifact name androidStoreApp/,
  )

  delete results.publications["@mentra/bluetooth-sdk"]["maven-central"]
  assert.throws(
    () => finalizeReleaseManifest({plan, results, completedAt: "2026-08-24T20:00:00.000Z"}),
    /publications\.@mentra\/bluetooth-sdk\.maven-central is missing/,
  )

  results.publications["@mentra/bluetooth-sdk"]["maven-central"] = publication(
    "com.mentraglass:bluetooth-sdk:3.1.0-beta.56",
  )
  assert.throws(
    () => finalizeReleaseManifest({plan, results, completedAt: "2026-08-24T20:00:00.000Z"}),
    /coordinate must be com\.mentraglass:bluetooth-sdk:3\.1\.0-beta\.57/,
  )

  results.publications["@mentra/bluetooth-sdk"]["maven-central"] = publication(
    "com.mentraglass:bluetooth-sdk:3.1.0-beta.57",
  )
  results.artifacts = results.artifacts.filter((artifact) => artifact.coordinate !== plan.artifactNames.iosApp)
  assert.throws(
    () => finalizeReleaseManifest({plan, results, completedAt: "2026-08-24T20:00:00.000Z"}),
    new RegExp(`Missing required artifact ${plan.artifactNames.iosApp}`),
  )

  results.artifacts.push(publication(plan.artifactNames.iosApp), publication(plan.artifactNames.iosApp))
  assert.throws(
    () => finalizeReleaseManifest({plan, results, completedAt: "2026-08-24T20:00:00.000Z"}),
    new RegExp(`artifacts contains duplicate coordinate ${plan.artifactNames.iosApp}`),
  )
})

test("rejects unknown dependencies and dependency cycles", () => {
  assert.throws(
    () => dependencyOrder([{name: "a", dependencies: ["missing"]}]),
    /dependency graph references unknown member missing/,
  )
  assert.throws(
    () =>
      dependencyOrder([
        {name: "a", dependencies: ["b"]},
        {name: "b", dependencies: ["a"]},
      ]),
    /dependency cycle: a -> b -> a/,
  )
})

test("can require package manifests to mirror the family base during activation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-release-family-"))
  mkdirSync(path.join(root, ".github"), {recursive: true})
  mkdirSync(path.join(root, "packages/example"), {recursive: true})
  writeChangelog(root)
  writeFileSync(path.join(root, "package.json"), JSON.stringify({version: "3.1.0"}))
  writeFileSync(path.join(root, "packages/example/package.json"), JSON.stringify({name: "example", version: "3.0.0"}))
  writeFileSync(
    path.join(root, ".github/release-family.json"),
    JSON.stringify({
      schemaVersion: 1,
      family: "mentra",
      versionSource: "package.json",
      products: ["example"],
      members: [
        {
          name: "example",
          manifest: "packages/example/package.json",
          kind: "product",
          publishTargets: ["npm"],
          dependencies: [],
        },
      ],
    }),
  )

  assert.throws(() => loadReleaseFamily({rootDir: root, requireVersionMirrors: true}), /does not mirror 3.1.0/)
})

test("requires exact regular dependencies between activated public family packages", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-release-family-"))
  mkdirSync(path.join(root, ".github"), {recursive: true})
  mkdirSync(path.join(root, "packages/base"), {recursive: true})
  mkdirSync(path.join(root, "packages/product"), {recursive: true})
  writeChangelog(root)
  writeFileSync(path.join(root, "package.json"), JSON.stringify({version: "3.1.0"}))
  writeFileSync(path.join(root, "packages/base/package.json"), JSON.stringify({name: "base", version: "3.1.0"}))
  writeFileSync(
    path.join(root, "packages/product/package.json"),
    JSON.stringify({name: "product", version: "3.1.0", dependencies: {base: "^3.1.0"}}),
  )
  writeFileSync(
    path.join(root, ".github/release-family.json"),
    JSON.stringify({
      schemaVersion: 1,
      family: "mentra",
      versionSource: "package.json",
      products: ["product"],
      members: [
        {
          name: "base",
          manifest: "packages/base/package.json",
          kind: "package",
          publishTargets: ["npm"],
          dependencies: [],
        },
        {
          name: "product",
          manifest: "packages/product/package.json",
          kind: "product",
          publishTargets: ["npm"],
          dependencies: ["base"],
        },
      ],
    }),
  )

  assert.throws(
    () => loadReleaseFamily({rootDir: root, requireVersionMirrors: true}),
    /dependencies\.base is "\^3\.1\.0", expected "3\.1\.0"/,
  )
})

test("rejects family dependencies hidden from the configured graph or declared as peers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-release-family-"))
  mkdirSync(path.join(root, ".github"), {recursive: true})
  mkdirSync(path.join(root, "packages/base"), {recursive: true})
  mkdirSync(path.join(root, "packages/product"), {recursive: true})
  writeChangelog(root)
  writeFileSync(path.join(root, "package.json"), JSON.stringify({version: "3.1.0"}))
  writeFileSync(path.join(root, "packages/base/package.json"), JSON.stringify({name: "base", version: "3.1.0"}))
  writeFileSync(
    path.join(root, "packages/product/package.json"),
    JSON.stringify({name: "product", version: "3.1.0", dependencies: {base: "3.1.0"}}),
  )
  const familyDefinition = {
    schemaVersion: 1,
    family: "mentra",
    versionSource: "package.json",
    products: ["product"],
    members: [
      {
        name: "base",
        manifest: "packages/base/package.json",
        kind: "package",
        publishTargets: ["npm"],
        dependencies: [],
      },
      {
        name: "product",
        manifest: "packages/product/package.json",
        kind: "product",
        publishTargets: ["npm"],
        dependencies: [],
      },
    ],
  }
  writeFileSync(path.join(root, ".github/release-family.json"), JSON.stringify(familyDefinition))

  assert.throws(
    () => loadReleaseFamily({rootDir: root, requireVersionMirrors: true}),
    /depends on base, but the release-family graph is missing that edge/,
  )

  familyDefinition.members[1].dependencies = ["base"]
  writeFileSync(path.join(root, ".github/release-family.json"), JSON.stringify(familyDefinition))
  writeFileSync(
    path.join(root, "packages/product/package.json"),
    JSON.stringify({
      name: "product",
      version: "3.1.0",
      dependencies: {base: "3.1.0"},
      peerDependencies: {base: "3.1.0"},
    }),
  )
  assert.throws(
    () => loadReleaseFamily({rootDir: root, requireVersionMirrors: true}),
    /must not declare family member base as a peerDependency/,
  )

  writeFileSync(
    path.join(root, "packages/product/package.json"),
    JSON.stringify({
      name: "product",
      version: "3.1.0",
      dependencies: {"base": "3.1.0", "@mentra/outside": "workspace:*"},
    }),
  )
  assert.throws(
    () => loadReleaseFamily({rootDir: root, requireVersionMirrors: true}),
    /unclassified first-party package @mentra\/outside/,
  )

  familyDefinition.members[1].privateWorkspaceDependencies = ["@mentra/outside"]
  writeFileSync(path.join(root, ".github/release-family.json"), JSON.stringify(familyDefinition))
  assert.doesNotThrow(() => loadReleaseFamily({rootDir: root, requireVersionMirrors: true}))
})
