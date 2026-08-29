import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {loadReleaseFamily} from "./release-family.mjs"
import {
  isHttpsRegistryUrl,
  npmMembersInOrder,
  npmReleaseTag,
  npmViewPublishedTarball,
  releaseMetadataArgs,
  requireNpmProvenanceSource,
  requirePlanSourceCommit,
  resolveNpmReleaseTag,
  sha512Integrity,
} from "./publish-release-npm.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("maps coordinated channels to npm tags", () => {
  assert.equal(npmReleaseTag("dev"), "dev")
  assert.equal(npmReleaseTag("beta"), "beta")
  assert.throws(() => npmReleaseTag("production"), /explicit candidate dist-tag/)
  assert.throws(() => npmReleaseTag("nightly"), /Unsupported/)
  assert.equal(resolveNpmReleaseTag("production", "candidate-3-1-0"), "candidate-3-1-0")
  assert.throws(() => resolveNpmReleaseTag("production", "3.1.0"), /Invalid npm dist-tag/)
})

test("selects npm packages in dependency order", () => {
  const family = loadReleaseFamily()
  const names = npmMembersInOrder(family, [
    "@mentra/miniapp",
    "@mentra/crust",
    "@mentra/cloud-client",
    "@mentra/cloud-protocol",
    "@mentra/jspolyfill",
  ])
  assert.deepEqual(names, [
    "@mentra/jspolyfill",
    "@mentra/cloud-protocol",
    "@mentra/crust",
    "@mentra/cloud-client",
    "@mentra/miniapp",
  ])
})

test("selects the complete npm family in dependency order", () => {
  const family = loadReleaseFamily({rootDir: repositoryRoot})
  const selected = npmMembersInOrder(family, ["all"])
  assert.equal(selected.length, family.members.filter((member) => member.publishTargets.includes("npm")).length)
  assert.equal(selected.includes("@mentra/types"), false)
  assert.equal(selected.at(-1), "@mentra/engine")
})

test("admits Engine only as the final selected npm package", () => {
  const family = loadReleaseFamily()
  const names = npmMembersInOrder(family, ["@mentra/engine", "@mentra/bluetooth-sdk"])
  assert.deepEqual(names, ["@mentra/bluetooth-sdk", "@mentra/engine"])
})

test("creates npm-compatible SHA-512 integrity values", () => {
  assert.match(sha512Integrity(Buffer.from("mentra")), /^sha512-[A-Za-z0-9+/]+=*$/)
})

test("accepts only propagated HTTPS npm tarball metadata", () => {
  assert.equal(isHttpsRegistryUrl("https://registry.npmjs.org/@mentra/crust/-/crust-3.1.0.tgz"), true)
  assert.equal(isHttpsRegistryUrl(""), false)
  assert.equal(isHttpsRegistryUrl(null), false)
  assert.equal(isHttpsRegistryUrl("http://registry.npmjs.org/package.tgz"), false)
})

test("waits through empty npm metadata until the registry exposes the tarball", () => {
  const responses = ["", null, '"https://registry.npmjs.org/package/-/package-3.1.0.tgz"']
  let sleeps = 0
  assert.equal(
    npmViewPublishedTarball("package@3.1.0", {
      attempts: responses.length,
      view: () => responses.shift(),
      sleep: () => {
        sleeps += 1
      },
    }),
    "https://registry.npmjs.org/package/-/package-3.1.0.tgz",
  )
  assert.equal(sleeps, 2)
})

test("requires the package checkout to match the immutable release plan", () => {
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {cwd: repositoryRoot, encoding: "utf8"}).trim()
  assert.equal(requirePlanSourceCommit(repositoryRoot, sourceCommit), sourceCommit)
  assert.throws(() => requirePlanSourceCommit(repositoryRoot, "a".repeat(40)), /expected a{40}/)
})

test("requires every npm member to identify its exact MentraOS source directory", () => {
  const family = loadReleaseFamily({rootDir: repositoryRoot})
  for (const member of family.members.filter((candidate) => candidate.publishTargets.includes("npm"))) {
    const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, member.manifest), "utf8"))
    assert.doesNotThrow(() => requireNpmProvenanceSource(packageJson, member.manifest))
  }
  assert.throws(
    () =>
      requireNpmProvenanceSource(
        {name: "@mentra/crust", repository: "https://github.com/fossephate/crust"},
        "mobile/modules/crust/package.json",
      ),
    /does not identify mobile\/modules\/crust in MentraOS/,
  )
})

test("stamps SDK and Engine packages from the same immutable release metadata", () => {
  assert.deepEqual(
    releaseMetadataArgs({
      plan: {
        familyBaseVersion: "3.1.0",
        releaseIdentity: "3.1.0-beta.57",
        releaseSetId: "mentra-3.1.0-beta.57",
        sourceCommit: "a".repeat(40),
      },
      otaManifestUrl: "https://example.com/ota.json",
      otaManifestSha256: "b".repeat(64),
    }),
    [
      "--family-base-version",
      "3.1.0",
      "--release-identity",
      "3.1.0-beta.57",
      "--release-set-id",
      "mentra-3.1.0-beta.57",
      "--source-commit",
      "a".repeat(40),
      "--ota-manifest-url",
      "https://example.com/ota.json",
      "--ota-manifest-sha256",
      "b".repeat(64),
    ],
  )
})
