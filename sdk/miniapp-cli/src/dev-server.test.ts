/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "fs"
import {tmpdir} from "os"
import {join} from "path"
import JSZip from "jszip"

import {buildProjectZip, listProjectFiles} from "./dev-server"

describe("listProjectFiles — dist/ inclusion", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mentra-dev-test-"))
  })

  afterEach(() => {
    rmSync(root, {recursive: true, force: true})
  })

  function touch(rel: string, contents = "// stub") {
    const abs = join(root, rel)
    mkdirSync(join(abs, ".."), {recursive: true})
    writeFileSync(abs, contents)
  }

  // Convenience: the zip-internal entry names the function produces.
  const entries = (root: string) => listProjectFiles(root).map((f) => f.entry)

  test("ships both build bundles with the dist/ prefix stripped off the entry names", () => {
    touch('miniapp.json', '{"packageName":"com.test","version":"1.0.0","name":"Test"}')
    touch("dist/background/index.js")
    touch("dist/ui/index.html")
    touch("dist/ui/main.js")
    touch("src/background/index.ts")
    const listed = listProjectFiles(root)
    // disk paths keep dist/ (that's where the files live)…
    expect(listed.map((f) => f.disk)).toContain("dist/background/index.js")
    // …but zip entry names drop it, matching miniapp.json's entry.* paths.
    expect(entries(root)).toContain("background/index.js")
    expect(entries(root)).toContain("ui/index.html")
    expect(entries(root)).toContain("ui/main.js")
    expect(entries(root)).toContain("miniapp.json")
    expect(entries(root)).not.toContain("dist/background/index.js")
  })

  test("strict allowlist: source + build config + node_modules + public are NOT shipped", () => {
    touch('miniapp.json', '{"packageName":"com.test","version":"1.0.0","name":"Test"}')
    touch("dist/background/index.js")
    touch("src/background/index.ts")
    touch("package.json")
    touch("tsconfig.json")
    touch("build.ts")
    touch("bunfig.toml")
    touch("node_modules/x/index.js")
    touch("public/fonts/big.ttf")
    const listed = entries(root)
    expect(listed.some((p) => p.startsWith("src/"))).toBe(false)
    expect(listed.some((p) => p.startsWith("public/"))).toBe(false)
    expect(listed.some((p) => p.startsWith("node_modules/"))).toBe(false)
    expect(listed).not.toContain("package.json")
    expect(listed).not.toContain("tsconfig.json")
    expect(listed).not.toContain("build.ts")
    expect(listed).not.toContain("bunfig.toml")
    expect(listed).toContain("miniapp.json")
    expect(listed).toContain("background/index.js")
  })

  test("ships the manifest-declared icon and skips unrelated images", () => {
    touch('miniapp.json', '{"packageName":"com.test","version":"1.0.0","name":"Test","icon":"my-icon.png"}')
    touch("my-icon.png")
    touch("other-image.png")
    touch("dist/background/index.js")
    const listed = entries(root)
    expect(listed).toContain("my-icon.png")
    expect(listed).not.toContain("other-image.png")
  })

  test("defaults to icon.png when manifest does not declare an icon", () => {
    touch('miniapp.json', '{"packageName":"com.test","version":"1.0.0","name":"Test"}')
    touch("icon.png")
    touch("dist/background/index.js")
    const listed = entries(root)
    expect(listed).toContain("icon.png")
  })

  test("skips icon if it is missing from disk (manifest may be stale)", () => {
    touch('miniapp.json', '{"packageName":"com.test","version":"1.0.0","name":"Test","icon":"icon.png"}')
    touch("dist/background/index.js")
    const listed = entries(root)
    expect(listed).not.toContain("icon.png")
  })
})

describe("buildProjectZip — two-output bundle contract", () => {
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

  test("zip ships both bundles at the root (dist/ prefix stripped), manifest at root", async () => {
    touch("miniapp.json", '{"packageName":"com.test","version":"1.0.0","name":"Test","hardwareRequirements":[]}')
    touch("dist/background/index.js", "console.log('bg')")
    touch("dist/ui/index.html", "<!doctype html><html></html>")
    touch("dist/ui/main.js", "console.log('ui')")
    const buf = await buildProjectZip(root)
    const zip = await JSZip.loadAsync(buf)
    expect(zip.files["miniapp.json"]).toBeDefined()
    expect(zip.files["background/index.js"]).toBeDefined()
    expect(zip.files["ui/index.html"]).toBeDefined()
    expect(zip.files["ui/main.js"]).toBeDefined()
    // The on-disk dist/ prefix must not leak into the zip layout.
    expect(zip.files["dist/background/index.js"]).toBeUndefined()
  })

  test("zip preserves file contents byte-for-byte", async () => {
    touch("miniapp.json", '{"a":1}')
    touch("dist/background/index.js", "/* bg-stub */")
    const buf = await buildProjectZip(root)
    const zip = await JSZip.loadAsync(buf)
    const manifest = await zip.files["miniapp.json"]!.async("string")
    const bg = await zip.files["background/index.js"]!.async("string")
    expect(manifest).toBe('{"a":1}')
    expect(bg).toBe("/* bg-stub */")
  })
})
