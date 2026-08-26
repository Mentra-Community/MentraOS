import assert from "node:assert/strict"
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {catalogOutputs, generateChangelogCatalog, readChangelogCatalog} from "./generate-changelog-catalog.mjs"

test("sorts root changelogs newest-first and generates every SDK language", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-changelogs-"))
  mkdirSync(path.join(root, "changelogs"))
  writeFileSync(path.join(root, "changelogs/3.1.0.md"), "First release\n")
  writeFileSync(path.join(root, "changelogs/3.3.0.md"), "Newest release\n")
  writeFileSync(path.join(root, "changelogs/3.2.0.md"), "Middle $release\n")

  assert.deepEqual(
    readChangelogCatalog(root).map(({version}) => version),
    ["3.3.0", "3.2.0", "3.1.0"],
  )
  generateChangelogCatalog(root)
  generateChangelogCatalog(root, {check: true})

  const outputs = catalogOutputs(root)
  assert.match(readFileSync(outputs.typescript, "utf8"), /Newest release/)
  assert.match(readFileSync(outputs.kotlin, "utf8"), /Middle \\\$release/)
  assert.match(readFileSync(outputs.swift, "utf8"), /First release/)
})

test("rejects non-version files and stale generated catalogs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-changelogs-"))
  mkdirSync(path.join(root, "changelogs"))
  writeFileSync(path.join(root, "changelogs/README.md"), "not a release")
  assert.throws(() => readChangelogCatalog(root), /only X.Y.Z.md/)

  const validRoot = mkdtempSync(path.join(tmpdir(), "mentra-changelogs-"))
  mkdirSync(path.join(validRoot, "changelogs"))
  writeFileSync(path.join(validRoot, "changelogs/3.1.0.md"), "Release")
  generateChangelogCatalog(validRoot)
  writeFileSync(catalogOutputs(validRoot).typescript, "stale")
  assert.throws(() => generateChangelogCatalog(validRoot, {check: true}), /is stale/)
})
