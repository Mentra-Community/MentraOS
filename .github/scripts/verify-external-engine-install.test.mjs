import assert from "node:assert/strict"
import {mkdtempSync, writeFileSync} from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {createReleasePlan, loadReleaseFamily} from "./release-family.mjs"
import {verifyExternalEngineInstall} from "./verify-external-engine-install.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const plan = createReleasePlan({
  family: loadReleaseFamily({rootDir: repositoryRoot}),
  channel: "beta",
  sequence: 57,
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: 310000057,
})
const expectedClosure = [
  "@mentra/bluetooth-sdk",
  "@mentra/cloud-client",
  "@mentra/cloud-protocol",
  "@mentra/crust",
  "@mentra/engine",
  "@mentra/jspolyfill",
  "@mentra/miniapp",
]

function fixture(lockPackages) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mentra-engine-install-"))
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({dependencies: {"@mentra/engine": plan.releaseIdentity, react: "19.2.0"}}),
  )
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({packages: lockPackages}))
  return root
}

function registry(version) {
  return {version, resolved: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz`, integrity: "sha512-example"}
}

function validLock() {
  return Object.fromEntries(
    expectedClosure.map((name) => [`node_modules/${name}`, registry(plan.releaseIdentity)]),
  )
}

test("accepts one exact registry-backed Engine closure", () => {
  const root = fixture(validLock())
  assert.deepEqual(verifyExternalEngineInstall({fixtureDir: root, plan}), expectedClosure)
})

test("rejects duplicate or workspace-resolved native modules", () => {
  const linked = validLock()
  linked["node_modules/@mentra/bluetooth-sdk"] = {...registry(plan.releaseIdentity), link: true}
  const root = fixture(linked)
  assert.throws(() => verifyExternalEngineInstall({fixtureDir: root, plan}), /integrity-checked public npm artifact/)

  const duplicateLock = validLock()
  duplicateLock["node_modules/@mentra/engine/node_modules/@mentra/bluetooth-sdk"] = registry(plan.releaseIdentity)
  const duplicate = fixture(duplicateLock)
  assert.throws(() => verifyExternalEngineInstall({fixtureDir: duplicate, plan}), /resolved 2 physical copies/)
})

test("rejects the array dependency shape that cannot occur in a generated plan", () => {
  const malformed = structuredClone(plan)
  malformed.members["@mentra/engine"].dependencies = ["@mentra/bluetooth-sdk"]
  assert.throws(
    () => verifyExternalEngineInstall({fixtureDir: fixture(validLock()), plan: malformed}),
    /dependencies for @mentra\/engine must be an object/,
  )
})
