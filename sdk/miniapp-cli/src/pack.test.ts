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
