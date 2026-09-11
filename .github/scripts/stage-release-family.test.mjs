import assert from "node:assert/strict"
import {cpSync, mkdirSync, mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {createReleasePlan, loadReleaseFamily, serializeReleaseRecord} from "./release-family.mjs"
import {stageReleaseFamily} from "./stage-release-family.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-release-stage-"))
  mkdirSync(path.join(root, ".github"), {recursive: true})
  cpSync(path.join(repositoryRoot, ".github/release-family.json"), path.join(root, ".github/release-family.json"), {
    recursive: true,
  })
  cpSync(path.join(repositoryRoot, "package.json"), path.join(root, "package.json"))
  cpSync(path.join(repositoryRoot, "changelogs"), path.join(root, "changelogs"), {recursive: true})
  const family = loadReleaseFamily({rootDir: repositoryRoot, requireVersionMirrors: true})
  for (const member of family.members) {
    const source = path.join(repositoryRoot, member.manifest)
    const destination = path.join(root, member.manifest)
    mkdirSync(path.dirname(destination), {recursive: true})
    cpSync(source, destination, {recursive: true})
  }
  return {root, family}
}

test("stages one exact prerelease identity without changing MentraOS workspace edges", () => {
  const {root, family} = fixture()
  const plan = createReleasePlan({
    family,
    channel: "beta",
    sequence: 57,
    sourceCommit: "a".repeat(40),
    nativeBuildNumber: 310000057,
  })

  const downloadedPlan = JSON.parse(serializeReleaseRecord(plan))
  stageReleaseFamily({rootDir: root, plan: downloadedPlan})

  for (const member of family.members) {
    const manifest = JSON.parse(readFileSync(path.join(root, member.manifest), "utf8"))
    assert.equal(manifest.version, "3.1.0-beta.57")
    for (const dependency of member.dependencies) {
      assert.equal(manifest.dependencies[dependency], member.name === "mentraos" ? "workspace:*" : "3.1.0-beta.57")
    }
  }
})

test("rejects a plan from another family base", () => {
  const {root, family} = fixture()
  const plan = createReleasePlan({
    family,
    channel: "dev",
    sequence: 4,
    sourceCommit: "b".repeat(40),
    nativeBuildNumber: 310000004,
  })
  plan.familyBaseVersion = "3.2.0"

  assert.throws(() => stageReleaseFamily({rootDir: root, plan}), /does not match source/)
})

test("rejects a plan whose changelog does not match the source", () => {
  const {root, family} = fixture()
  const plan = createReleasePlan({
    family,
    channel: "dev",
    sequence: 4,
    sourceCommit: "b".repeat(40),
    nativeBuildNumber: 310000004,
  })
  plan.changelog.sha256 = "0".repeat(64)

  assert.throws(() => stageReleaseFamily({rootDir: root, plan}), /changelog does not match/)
})
