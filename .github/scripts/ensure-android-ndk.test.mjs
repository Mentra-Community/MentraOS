import assert from "node:assert/strict"
import test from "node:test"
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {ensureAndroidNdk} from "./ensure-android-ndk.mjs"
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "android-ndk-"))
  try {
    const version = "27.1.12297006", sdkRoot = path.join(root, "sdk"), versionsFile = path.join(root, "libs.versions.toml")
    const directory = path.join(sdkRoot, "ndk", version), other = path.join(sdkRoot, "ndk", "other")
    await mkdir(directory, {recursive: true}); await mkdir(other); await writeFile(path.join(other, "keep"), "another installed NDK")
    await writeFile(versionsFile, `ndkVersion = "${version}"\n`)
    await run({version, sdkRoot, versionsFile, directory})
    assert.equal(await readFile(path.join(other, "keep"), "utf8"), "another installed NDK")
  } finally {await rm(root, {recursive: true, force: true})}
}
test("partial NDK is repaired before Gradle without touching other versions", () => fixture(async f => {
  await writeFile(path.join(f.directory, "partial-download"), "incomplete")
  const result = await ensureAndroidNdk({...f, install: async (version, sdk) => {
    assert.equal(version, f.version)
    assert.equal(sdk, await realpath(f.sdkRoot))
    await assert.rejects(readFile(path.join(f.directory, "partial-download")))
    await mkdir(f.directory); await writeFile(path.join(f.directory, "source.properties"), `Pkg.Revision = ${version}\n`)
  }})
  assert.deepEqual(result, {version: f.version, installed: true})
}))
test("healthy pinned NDK is reused without reinstall", () => fixture(async f => {
  await writeFile(path.join(f.directory, "source.properties"), `Pkg.Revision = ${f.version}\n`)
  assert.deepEqual(await ensureAndroidNdk({...f, install: () => {throw new Error("No installation needed")}}), {version: f.version, installed: false})
}))
test("a reported SDK install success without valid metadata still fails early", () => fixture(async f => {
  await assert.rejects(ensureAndroidNdk({...f, install: () => {}}), /still incomplete/)
}))
