import {afterEach, describe, expect, test} from "bun:test"
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import JSZip from "jszip"
import {pack} from "./pack"
import {generatePackageSigningKey} from "./package-signing-key"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true})
})

describe("pack", () => {
  test("does not retain stale files from an older archive", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mentra-pack-"))
    dirs.push(cwd)
    mkdirSync(join(cwd, "dist"))
    writeFileSync(
      join(cwd, "miniapp.json"),
      JSON.stringify({
        packageName: "com.example.pack",
        version: "1.0.0",
        name: "Pack Test",
        permissions: [],
        hardwareRequirements: [],
      }),
    )
    writeFileSync(join(cwd, "dist", "old.js"), "old")
    const signingKey = generatePackageSigningKey("com.example.pack")
    const zipPath = await pack({cwd, silent: true, signingKey})

    rmSync(join(cwd, "dist", "old.js"))
    writeFileSync(join(cwd, "dist", "new.js"), "new")
    await pack({cwd, silent: true, signingKey})

    const zip = await JSZip.loadAsync(await Bun.file(zipPath).arrayBuffer())
    expect(zip.file("new.js")).not.toBeNull()
    expect(zip.file("old.js")).toBeNull()
  })

  test("keeps the previous archive when zip creation fails", async () => {
    const cwd = createProject()
    const signingKey = generatePackageSigningKey("com.example.pack")
    const zipPath = await pack({cwd, silent: true, signingKey})
    const original = readFileSync(zipPath)

    await expect(pack({cwd, silent: true, zipCommand: "/usr/bin/false", signingKey})).rejects.toThrow(
      "zip command failed",
    )
    expect(readFileSync(zipPath)).toEqual(original)
  })

  test("leaves the bundle unsigned unless signing is asked for", async () => {
    // Signing pins a package's publisher for every later update and the
    // envelope has no rotation chain, so a plain repack must never take that
    // door on the developer's behalf.
    const cwd = createProject()
    const zipPath = await pack({cwd, silent: true})

    const zip = await JSZip.loadAsync(await Bun.file(zipPath).arrayBuffer())
    expect(zip.file("META-INF/MENTRA.SIG")).toBeNull()
    expect(zip.file("miniapp.json")).not.toBeNull()
  })

  test("signs when asked, with the key from the store", async () => {
    const cwd = createProject()
    const signingKey = generatePackageSigningKey("com.example.pack")
    const zipPath = await pack({cwd, silent: true, sign: true, signingKey})

    const zip = await JSZip.loadAsync(await Bun.file(zipPath).arrayBuffer())
    expect(zip.file("META-INF/MENTRA.SIG")).not.toBeNull()
  })

  test("treats an explicit key as the request to sign", async () => {
    const cwd = createProject()
    const signingKey = generatePackageSigningKey("com.example.pack")
    const zipPath = await pack({cwd, silent: true, signingKey})

    const zip = await JSZip.loadAsync(await Bun.file(zipPath).arrayBuffer())
    expect(zip.file("META-INF/MENTRA.SIG")).not.toBeNull()
  })
})

function createProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "mentra-pack-"))
  dirs.push(cwd)
  mkdirSync(join(cwd, "dist"))
  writeFileSync(
    join(cwd, "miniapp.json"),
    JSON.stringify({
      packageName: "com.example.pack",
      version: "1.0.0",
      name: "Pack Test",
      permissions: [],
      hardwareRequirements: [],
    }),
  )
  writeFileSync(join(cwd, "dist", "index.js"), "export {}")
  return cwd
}
