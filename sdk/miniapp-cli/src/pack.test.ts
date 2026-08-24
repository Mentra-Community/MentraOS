import {afterEach, describe, expect, test} from "bun:test"
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import JSZip from "jszip"
import {pack} from "./pack"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true})
})

describe("pack", () => {
  test("does not retain stale files from an older archive", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mentra-pack-"))
    dirs.push(cwd)
    mkdirSync(join(cwd, "dist"))
    writeFileSync(join(cwd, "miniapp.json"), JSON.stringify({
      packageName: "com.example.pack",
      version: "1.0.0",
      name: "Pack Test",
      permissions: [],
      hardwareRequirements: [],
    }))
    writeFileSync(join(cwd, "dist", "old.js"), "old")
    const zipPath = await pack({cwd, silent: true})

    rmSync(join(cwd, "dist", "old.js"))
    writeFileSync(join(cwd, "dist", "new.js"), "new")
    await pack({cwd, silent: true})

    const zip = await JSZip.loadAsync(await Bun.file(zipPath).arrayBuffer())
    expect(zip.file("new.js")).not.toBeNull()
    expect(zip.file("old.js")).toBeNull()
  })
})
