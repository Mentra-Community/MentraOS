import assert from "node:assert/strict"
import {afterEach, test} from "node:test"
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {claimInstallation} from "./install-ios-mac.mjs"

const roots = []
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mentra-installer-test-"))
  roots.push(root)
  return path.join(root, "Applications", "Mentra E2E")
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

test("reuse the same managed installation across builds", async () => {
  const root = await fixture()
  await claimInstallation(root, "com.mentra.mentra")
  await writeFile(path.join(root, "retained.txt"), "existing installation")
  await claimInstallation(root, "com.mentra.mentra")
  assert.equal(await readFile(path.join(root, "retained.txt"), "utf8"), "existing installation")
})

test("refuse an existing directory without this installer's marker", async () => {
  const root = await fixture()
  await mkdir(root, {recursive: true})
  await writeFile(path.join(root, "retained.txt"), "unrelated data")
  await assert.rejects(claimInstallation(root, "com.mentra.mentra"))
  assert.equal(await readFile(path.join(root, "retained.txt"), "utf8"), "unrelated data")
})

test("refuse another bundle and a symlinked installation", async () => {
  const root = await fixture()
  await claimInstallation(root, "another.bundle")
  await assert.rejects(claimInstallation(root, "com.mentra.mentra"), /not owned/)
  const alias = path.join(path.dirname(root), "alias")
  await symlink(root, alias)
  await assert.rejects(claimInstallation(alias, "another.bundle"), /real directory/)
})
