/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "fs"
import {tmpdir} from "os"
import {join} from "path"
import JSZip from "jszip"

import {buildProjectZip, listProjectFiles} from "./dev-server"

describe("listProjectFiles — Phase 4 dist/ inclusion", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mentra-dev-test-"))
  })

  afterEach(() => {
    rmSync(root, {recursive: true, force: true})
  })

  function touch(rel: string) {
    const abs = join(root, rel)
    mkdirSync(join(abs, ".."), {recursive: true})
    writeFileSync(abs, "// stub")
  }

  test("includes dist/background/index.js + dist/ui/index.html so the snapshot ships both bundles", () => {
    touch("miniapp.json")
    touch("dist/background/index.js")
    touch("dist/ui/index.html")
    touch("dist/ui/main.js")
    touch("src/background/index.ts")
    const listed = listProjectFiles(root)
    expect(listed).toContain("dist/background/index.js")
    expect(listed).toContain("dist/ui/index.html")
    expect(listed).toContain("dist/ui/main.js")
    expect(listed).toContain("miniapp.json")
  })

  test("excludes node_modules / .git / .next", () => {
    touch("node_modules/x/index.js")
    touch(".git/HEAD")
    touch(".next/build/manifest.json")
    touch("miniapp.json")
    const listed = listProjectFiles(root)
    expect(listed.some((p) => p.startsWith("node_modules/"))).toBe(false)
    expect(listed.some((p) => p.startsWith(".git/"))).toBe(false)
    expect(listed.some((p) => p.startsWith(".next/"))).toBe(false)
    expect(listed).toContain("miniapp.json")
  })

  test("excludes hidden .env files but allows top-level config files", () => {
    touch(".env.local")
    touch(".env")
    touch("package.json")
    const listed = listProjectFiles(root)
    expect(listed.some((p) => p.startsWith(".env"))).toBe(false)
    expect(listed).toContain("package.json")
  })
})

describe("buildProjectZip — Phase 4 two-output bundle contract", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mentra-zip-test-"))
  })

  afterEach(() => {
    rmSync(root, {recursive: true, force: true})
  })

  function touch(rel: string, contents = "// stub") {
    const abs = join(root, rel)
    mkdirSync(join(abs, ".."), {recursive: true})
    writeFileSync(abs, contents)
  }

  test("zip contains BOTH dist/background/index.js AND dist/ui/index.html with their prefixes", async () => {
    touch("miniapp.json", '{"packageName":"com.test","version":"1.0.0","name":"Test","hardwareRequirements":[]}')
    touch("dist/background/index.js", "console.log('bg')")
    touch("dist/ui/index.html", "<!doctype html><html></html>")
    touch("dist/ui/main.js", "console.log('ui')")
    const buf = await buildProjectZip(root)
    const zip = await JSZip.loadAsync(buf)
    expect(zip.files["miniapp.json"]).toBeDefined()
    expect(zip.files["dist/background/index.js"]).toBeDefined()
    expect(zip.files["dist/ui/index.html"]).toBeDefined()
    expect(zip.files["dist/ui/main.js"]).toBeDefined()
  })

  test("zip preserves file contents byte-for-byte", async () => {
    touch("miniapp.json", '{"a":1}')
    touch("dist/background/index.js", "/* bg-stub */")
    const buf = await buildProjectZip(root)
    const zip = await JSZip.loadAsync(buf)
    const manifest = await zip.files["miniapp.json"]!.async("string")
    const bg = await zip.files["dist/background/index.js"]!.async("string")
    expect(manifest).toBe('{"a":1}')
    expect(bg).toBe("/* bg-stub */")
  })
})
