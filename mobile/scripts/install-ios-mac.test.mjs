import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {afterEach, test} from "node:test"
import {mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {
  claimInstallation,
  commitStagedInstallation,
  InstallationRollbackError,
  installBuild,
  isPortableMacPackage,
  parseInstallerArgs,
  verifyLauncherOverride,
} from "./install-ios-mac.mjs"

const roots = []
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mentra-installer-test-"))
  roots.push(root)
  return path.join(root, "Applications", "Mentra E2E")
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function launcherFixture() {
  const root = await fixture()
  await mkdir(root, {recursive: true})
  const file = path.join(root, "launcher")
  const contents = "verified launcher fixture; never executed"
  await writeFile(file, contents)
  return {file: await realpath(file), sha256: createHash("sha256").update(contents).digest("hex")}
}

test("preinstalled launcher must match its independently supplied pin", async () => {
  const {file, sha256} = await launcherFixture()
  assert.deepEqual(await verifyLauncherOverride(file, sha256), {source: "preinstalled", path: file, sha256})
  assert.equal(await verifyLauncherOverride(), undefined)
  await assert.rejects(verifyLauncherOverride(file, "0".repeat(64)), /SHA256 mismatch/)
  await writeFile(file, "replaced launcher")
  await assert.rejects(verifyLauncherOverride(file, sha256), /SHA256 mismatch/)
})

test("missing or non-file preinstalled launchers are rejected", async () => {
  const {file, sha256} = await launcherFixture()
  await assert.rejects(verifyLauncherOverride(`${file}-missing`, sha256), {code: "ENOENT"})
  await assert.rejects(verifyLauncherOverride(path.dirname(file), sha256), /regular file/)
})

test("preinstalled launcher rejects a symlink or a symlinked parent", async () => {
  const {file, sha256} = await launcherFixture()
  const alias = `${file}-alias`
  await symlink(file, alias)
  await assert.rejects(verifyLauncherOverride(alias, sha256), /without symlinks/)
  const parentAlias = path.join(path.dirname(path.dirname(file)), "alias")
  await symlink(path.dirname(file), parentAlias)
  await assert.rejects(verifyLauncherOverride(path.join(parentAlias, "launcher"), sha256), /without symlinks/)
})

test("preinstalled launcher requires a canonical absolute path and a complete SHA256 pin", async () => {
  const {file, sha256} = await launcherFixture()
  await assert.rejects(verifyLauncherOverride("relative/launcher", sha256), /absolute canonical path/)
  await assert.rejects(verifyLauncherOverride(`${path.dirname(file)}/./launcher`, sha256), /absolute canonical path/)
  await assert.rejects(verifyLauncherOverride(file, "short-pin"), /Invalid.*SHA256/)
  await assert.rejects(verifyLauncherOverride(file), /together/)
  await assert.rejects(verifyLauncherOverride(undefined, sha256), /together/)
})

test("installer CLI preserves existing defaults and accepts the pinned launcher pair", () => {
  assert.deepEqual(parseInstallerArgs(["--manifest", "build.json"]), {
    manifestPath: path.resolve("build.json"),
    launch: true,
    launcherPath: undefined,
    launcherSha256: undefined,
  })
  assert.deepEqual(
    parseInstallerArgs([
      "--manifest",
      "build.json",
      "--launcher",
      "/host/launcher",
      "--launcher-sha256",
      "a".repeat(64),
      "--no-launch",
    ]),
    {
      manifestPath: path.resolve("build.json"),
      launch: false,
      launcherPath: "/host/launcher",
      launcherSha256: "a".repeat(64),
    },
  )
})

test("installer CLI rejects incomplete launcher selection and malformed arguments", () => {
  assert.throws(() => parseInstallerArgs(["--manifest", "build.json", "--launcher", "/host/launcher"]), /together/)
  assert.throws(() => parseInstallerArgs(["--manifest", "build.json", "--launcher-sha256", "a".repeat(64)]), /together/)
  assert.throws(() => parseInstallerArgs(["--manifest", "build.json", "--launcher"]))
  assert.throws(() => parseInstallerArgs(["--manifest", "build.json", "--unknown"]))
  assert.throws(() => parseInstallerArgs([]), /Usage:/)
})

test("both CI package formats use portable provisioning checks without requiring Xcode", () => {
  assert.equal(isPortableMacPackage({app: "Mentra.app"}), false)
  assert.equal(isPortableMacPackage({app: "Mentra.app", launcherPath: "launch-ios-on-mac"}), true)
  const native = {app: "Mentra.app", macPackageVersion: 2, macInstaller: "Install Mentra.app"}
  assert.equal(isPortableMacPackage(native), true)
  assert.throws(() => isPortableMacPackage({...native, launcherPath: "old-helper"}), /layout/)
  assert.throws(() => isPortableMacPackage({...native, macInstaller: "../other.app"}), /layout/)
  assert.throws(() => isPortableMacPackage({...native, macPackageVersion: 3}), /Unsupported/)
})

test(
  "a native Mac ZIP requires a pinned host helper before changing the installation",
  {skip: process.platform !== "darwin"},
  async () => {
    const root = await fixture()
    await mkdir(root, {recursive: true})
    const manifest = path.join(root, "build.json")
    await writeFile(
      manifest,
      JSON.stringify({
        app: "Mentra.app",
        bundleId: "com.mentra.mentra",
        executableSha256: "a".repeat(64),
        macPackageVersion: 2,
        macInstaller: "Install Mentra.app",
      }),
    )
    await assert.rejects(installBuild(manifest), /open Install Mentra.app.*--launcher/)
  },
)

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
