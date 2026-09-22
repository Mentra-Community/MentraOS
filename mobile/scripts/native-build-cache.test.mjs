import {test} from "node:test"
import assert from "node:assert/strict"
import {mkdtempSync, rmSync, statSync, utimesSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {cacheScope, snapshotSources, restoreSourceTimes} from "./native-build-cache.mjs"

test("native cache scope isolates workspace, tools, dependencies and runtime environment", () => {
  const base = {workspace: "/build/repo", xcode: "26.2", node: "20", bun: "1.4", environment: {backend: "dev"}, dependencies: "lock1"}
  for (const key of Object.keys(base)) assert.notEqual(cacheScope(base), cacheScope({...base, [key]: "changed"}))
  assert.equal(cacheScope(base), cacheScope({...base}))
})

test("checkout timestamps are restored only for byte-identical current sources", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-source-times-"))
  try {
    for (const name of ["unchanged.swift", "release.kt", "removed.ts"]) {
      writeFileSync(path.join(root, name), "old")
      utimesSync(path.join(root, name), new Date(100000), new Date(100000))
    }
    const before = snapshotSources(root, ["unchanged.swift", "release.kt", "removed.ts"])
    utimesSync(path.join(root, "unchanged.swift"), new Date(), new Date())
    writeFileSync(path.join(root, "release.kt"), "new release metadata")
    writeFileSync(path.join(root, "new.ts"), "new")
    rmSync(path.join(root, "removed.ts"))
    before["../outside"] = before["unchanged.swift"]
    assert.equal(restoreSourceTimes(root, ["unchanged.swift", "release.kt", "new.ts"], before), 1)
    assert.equal(statSync(path.join(root, "unchanged.swift")).mtimeMs, 100000)
    assert.notEqual(statSync(path.join(root, "release.kt")).mtimeMs, 100000)
    assert.notEqual(statSync(path.join(root, "new.ts")).mtimeMs, 100000)
  } finally { rmSync(root, {recursive: true, force: true}) }
})
