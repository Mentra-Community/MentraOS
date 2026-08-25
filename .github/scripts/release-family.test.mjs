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
  loadReleaseFamily,
} from "./release-family.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("loads the repository release family and derives dependency-first publication order", () => {
  const family = loadReleaseFamily({rootDir: repositoryRoot})

  assert.equal(family.familyBaseVersion, "3.1.0")
  assert.deepEqual(family.products, ["mentraos", "@mentra/engine", "@mentra/bluetooth-sdk"])
  assert.equal(family.members.length, 8)
  assert.ok(family.publicationOrder.indexOf("@mentra/jspolyfill") < family.publicationOrder.indexOf("@mentra/crust"))
  assert.ok(
    family.publicationOrder.indexOf("@mentra/bluetooth-sdk") < family.publicationOrder.indexOf("@mentra/engine"),
  )
  assert.ok(family.publicationOrder.indexOf("@mentra/engine") < family.publicationOrder.indexOf("mentraos"))
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
  assert.equal(plan.dependencies["@mentra/engine"]["@mentra/bluetooth-sdk"], "3.1.0-beta.57")
  assert.equal(plan.otaInputs.firmwareManifest, "firmware_live.json")
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
