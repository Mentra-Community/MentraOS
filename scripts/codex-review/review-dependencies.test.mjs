import {afterAll, expect, test} from "bun:test"
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {spawnSync} from "node:child_process"

const roots = []
afterAll(() => roots.forEach((root) => rmSync(root, {recursive: true, force: true})))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-deps-"));roots.push(root)
  const review = join(root, "review"), anchor = join(root, "anchor"), storage = join(root, "storage")
  for (const path of [review, anchor, join(storage, "node_modules")]) mkdirSync(path, {recursive: true})
  symlinkSync(join(storage, "node_modules"), join(anchor, "node_modules"))
  const run = () => spawnSync("node", [new URL("./review-dependencies.mjs", import.meta.url).pathname, review, anchor], {encoding: "utf8"})
  return {review, anchor, storage, run}
}

test("compatible package storage resolves external packages while nested links stay in the approved roots", () => {
  const f = fixture(), nested = join(f.storage, "tools/mentra-e2e/node_modules")
  mkdirSync(nested, {recursive: true});mkdirSync(join(f.anchor, "tools/mentra-e2e"), {recursive: true})
  mkdirSync(join(f.review, "tools/mentra-e2e"), {recursive: true})
  writeFileSync(join(f.review, "tools/mentra-e2e/package.json"), '{}')
  writeFileSync(join(f.storage, "tools/mentra-e2e/package.json"), '{}')
  symlinkSync(nested, join(f.anchor, "tools/mentra-e2e/node_modules"))
  const pkg = join(f.storage, "node_modules/external")
  mkdirSync(pkg);writeFileSync(join(pkg, "index.cjs"), 'module.exports = "external package"')
  symlinkSync(pkg, join(nested, "external"))
  expect(f.run().status).toBe(0)
  const resolved = spawnSync("node", ["-e", 'process.stdout.write(require(process.argv[1]))', join(nested, "external/index.cjs")], {encoding: "utf8"})
  expect(resolved.stdout).toBe("external package")
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
