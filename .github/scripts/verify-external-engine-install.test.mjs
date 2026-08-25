import assert from "node:assert/strict"
import {mkdtempSync, writeFileSync} from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {verifyExternalEngineInstall} from "./verify-external-engine-install.mjs"

const plan = {
  releaseIdentity: "3.1.0-beta.57",
  members: {
    "@mentra/bluetooth-sdk": {dependencies: []},
    "@mentra/crust": {dependencies: []},
    "@mentra/engine": {dependencies: ["@mentra/bluetooth-sdk", "@mentra/crust"]},
  },
}

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

test("accepts one exact registry-backed Engine closure", () => {
  const root = fixture({
    "node_modules/@mentra/engine": registry(plan.releaseIdentity),
    "node_modules/@mentra/bluetooth-sdk": registry(plan.releaseIdentity),
    "node_modules/@mentra/crust": registry(plan.releaseIdentity),
  })
  assert.deepEqual(verifyExternalEngineInstall({fixtureDir: root, plan}), [
    "@mentra/bluetooth-sdk",
    "@mentra/crust",
    "@mentra/engine",
  ])
})

test("rejects duplicate or workspace-resolved native modules", () => {
  const root = fixture({
    "node_modules/@mentra/engine": registry(plan.releaseIdentity),
    "node_modules/@mentra/bluetooth-sdk": {...registry(plan.releaseIdentity), link: true},
    "node_modules/@mentra/crust": registry(plan.releaseIdentity),
  })
  assert.throws(() => verifyExternalEngineInstall({fixtureDir: root, plan}), /integrity-checked public npm artifact/)

  const duplicate = fixture({
    "node_modules/@mentra/engine": registry(plan.releaseIdentity),
    "node_modules/@mentra/bluetooth-sdk": registry(plan.releaseIdentity),
    "node_modules/@mentra/engine/node_modules/@mentra/bluetooth-sdk": registry(plan.releaseIdentity),
    "node_modules/@mentra/crust": registry(plan.releaseIdentity),
  })
  assert.throws(() => verifyExternalEngineInstall({fixtureDir: duplicate, plan}), /resolved 2 physical copies/)
})
