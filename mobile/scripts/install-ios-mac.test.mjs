import assert from "node:assert/strict"
import {afterEach, test} from "node:test"
import {mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {claimInstallation, commitStagedInstallation, InstallationRollbackError} from "./install-ios-mac.mjs"

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

async function replacementFixture(existing = true) {
  const root = await fixture()
  await claimInstallation(root, "com.mentra.mentra")
  const staging = path.join(root, ".staging-test")
  const lock = path.join(root, ".install-lock")
  await mkdir(path.join(staging, "Mentra.app"), {recursive: true})
  await mkdir(lock)
  await writeFile(path.join(staging, "Mentra.app", "binary"), "new")
  await writeFile(path.join(staging, "installed-build.json"), "new manifest")
  if (existing) {
    await mkdir(path.join(root, "Mentra.app"))
    await writeFile(path.join(root, "Mentra.app", "binary"), "old")
    await writeFile(path.join(root, "installed-build.json"), "old manifest")
  }
  return {root, staging, lock}
}

test("commit promotes the matching app and manifest together", async () => {
  const paths = await replacementFixture()
  await commitStagedInstallation(paths)
  assert.equal(await readFile(path.join(paths.root, "Mentra.app", "binary"), "utf8"), "new")
  assert.equal(await readFile(path.join(paths.root, "installed-build.json"), "utf8"), "new manifest")
  assert.equal(await readFile(path.join(paths.lock, "previous.app", "binary"), "utf8"), "old")
})

test("manifest promotion failure restores the existing app and manifest", async () => {
  const paths = await replacementFixture()
  await assert.rejects(
    commitStagedInstallation(paths, async (from, to) => {
      if (from.endsWith("installed-build.json")) throw new Error("injected manifest failure")
      return rename(from, to)
    }),
    /manifest failure/,
  )
  assert.equal(await readFile(path.join(paths.root, "Mentra.app", "binary"), "utf8"), "old")
  assert.equal(await readFile(path.join(paths.root, "installed-build.json"), "utf8"), "old manifest")
  assert.equal(await readFile(path.join(paths.staging, "Mentra.app", "binary"), "utf8"), "new")
})

test("a failed first install leaves no unmatched live app", async () => {
  const paths = await replacementFixture(false)
  await assert.rejects(
    commitStagedInstallation(paths, async (from, to) => {
      if (from.endsWith("installed-build.json")) throw new Error("injected manifest failure")
      return rename(from, to)
    }),
    /manifest failure/,
  )
  await assert.rejects(readFile(path.join(paths.root, "Mentra.app", "binary")), {code: "ENOENT"})
  await assert.rejects(readFile(path.join(paths.root, "installed-build.json")), {code: "ENOENT"})
  assert.equal(await readFile(path.join(paths.staging, "Mentra.app", "binary"), "utf8"), "new")
})

test("failed rollback retains both generations for recovery", async () => {
  const paths = await replacementFixture()
  await assert.rejects(
    commitStagedInstallation(paths, async (from, to) => {
      if (from.endsWith("installed-build.json")) throw new Error("injected manifest failure")
      if (from === path.join(paths.root, "Mentra.app") && to.startsWith(paths.staging))
        throw new Error("injected rollback failure")
      return rename(from, to)
    }),
    InstallationRollbackError,
  )
  assert.equal(await readFile(path.join(paths.lock, "previous.app", "binary"), "utf8"), "old")
  assert.equal(await readFile(path.join(paths.root, "Mentra.app", "binary"), "utf8"), "new")
  assert.equal(await readFile(path.join(paths.root, "installed-build.json"), "utf8"), "old manifest")
  assert.equal(await readFile(path.join(paths.staging, "installed-build.json"), "utf8"), "new manifest")
})
