import {afterAll, expect, test} from "bun:test"
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {fileURLToPath} from "node:url"
import {spawnSync} from "node:child_process"

const roots = []
afterAll(() => roots.forEach((root) => rmSync(root, {recursive: true, force: true})))
const linkDirectory = (target, path) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir")
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-deps-"));roots.push(root)
  const review = join(root, "review"), anchor = join(root, "anchor"), storage = join(root, "storage")
  for (const path of [review, anchor, join(storage, "node_modules")]) mkdirSync(path, {recursive: true})
  linkDirectory(join(storage, "node_modules"), join(anchor, "node_modules"))
  const run = () => spawnSync("node", [fileURLToPath(new URL("./review-dependencies.mjs", import.meta.url)), review, anchor], {encoding: "utf8"})
  return {review, anchor, storage, run}
}

test("compatible package storage resolves external packages while nested links stay in the approved roots", () => {
  const f = fixture(), nested = join(f.storage, "tools/mentra-e2e/node_modules")
  mkdirSync(nested, {recursive: true});mkdirSync(join(f.anchor, "tools/mentra-e2e"), {recursive: true})
  mkdirSync(join(f.review, "tools/mentra-e2e"), {recursive: true})
  writeFileSync(join(f.review, "tools/mentra-e2e/package.json"), '{}')
  writeFileSync(join(f.storage, "tools/mentra-e2e/package.json"), '{}')
  linkDirectory(nested, join(f.anchor, "tools/mentra-e2e/node_modules"))
  const pkg = join(f.storage, "node_modules/external")
  mkdirSync(pkg);writeFileSync(join(pkg, "index.cjs"), 'module.exports = "external package"')
  linkDirectory(pkg, join(nested, "external"))
  expect(f.run().status).toBe(0)
  const resolved = spawnSync("node", ["-e", 'process.stdout.write(require(process.argv[1]))', join(nested, "external/index.cjs")], {encoding: "utf8"})
  expect(resolved.stdout).toBe("external package")
})

test("Bun package links resolve to sibling packages within shared node_modules", () => {
  const f = fixture(), bun = join(f.storage, "node_modules/.bun")
  const azure = join(bun, "@azure+abort-controller@1.1.0/node_modules")
  const tslib = join(bun, "tslib@2.8.1/node_modules/tslib")
  mkdirSync(azure, {recursive: true});mkdirSync(tslib, {recursive: true})
  writeFileSync(join(tslib, "index.js"), "module.exports = {}")
  linkDirectory(tslib, join(azure, "tslib"))
  expect(f.run().status).toBe(0)
})

test("changed dependency declarations, local dependencies, and lockfiles cannot reuse an install", () => {
  const f = fixture()
  const write = (directory, deps) => writeFileSync(join(directory, "package.json"), JSON.stringify({dependencies: deps}))
  write(f.review, {external: "1.0.0"});write(f.storage, {external: "1.0.0"})
  writeFileSync(join(f.review, "bun.lock"), "exact resolution");writeFileSync(join(f.storage, "bun.lock"), "exact resolution")
  expect(f.run().status).toBe(0)
  write(f.review, {external: "2.0.0"});expect(f.run().stderr).toContain("declarations differ")
  write(f.review, {external: "1.0.0"});writeFileSync(join(f.review, "bun.lock"), "changed resolution")
  expect(f.run().stderr).toContain("lock differs")
  write(f.review, {external: "workspace:*"});expect(f.run().stderr).toContain("local or workspace dependency")
})

test("a skipped optional package cannot be a bridge to anchor source", () => {
  const f = fixture(), nested = join(f.storage, "tools/mentra-e2e/node_modules"), source = join(f.anchor, "source")
  mkdirSync(nested, {recursive: true});mkdirSync(join(f.anchor, "tools/mentra-e2e"), {recursive: true});mkdirSync(source)
  writeFileSync(join(source, "index.cjs"), 'module.exports = "ANCHOR SOURCE"')
  linkDirectory(nested, join(f.anchor, "tools/mentra-e2e/node_modules"))
  linkDirectory(source, join(nested, "source"));linkDirectory(join(nested, "source"), join(f.storage, "node_modules/bridge"))
  const unsafe = spawnSync("node", ["-e", 'process.stdout.write(require(process.argv[1]))', join(f.storage, "node_modules/bridge/index.cjs")], {encoding: "utf8"})
  expect(unsafe.stdout).toBe("ANCHOR SOURCE")
  expect(f.run().stderr).toContain("escapes external package storage")
})
