import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {loadReleaseFamily} from "./release-family.mjs"
import {
  npmMembersInOrder,
  npmReleaseTag,
  requireNpmProvenanceSource,
  requirePlanSourceCommit,
  sha512Integrity,
} from "./publish-release-npm.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("maps coordinated channels to npm tags", () => {
  assert.equal(npmReleaseTag("dev"), "dev")
  assert.equal(npmReleaseTag("beta"), "beta")
  assert.throws(() => npmReleaseTag("production"), /explicit candidate dist-tag/)
  assert.throws(() => npmReleaseTag("nightly"), /Unsupported/)
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

test("creates npm-compatible SHA-512 integrity values", () => {
  assert.match(sha512Integrity(Buffer.from("mentra")), /^sha512-[A-Za-z0-9+/]+=*$/)
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
