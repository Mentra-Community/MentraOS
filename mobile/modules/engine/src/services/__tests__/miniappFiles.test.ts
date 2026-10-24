import {afterEach, beforeEach, describe, expect, it, mock, spyOn} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {FakeDirectory, FakePaths, crustRealpath, fakeExpoFileSystem, uriOf, useFakeRoots} from "./fakeExpoFileSystem"

const crust: {canonicalFilePath?: (path: string) => string | null} = {canonicalFilePath: crustRealpath}
mock.module("expo-file-system", () => fakeExpoFileSystem)
mock.module("@mentra/crust", () => ({default: crust}))
const {canonicalPath, fileInside, linkedEntry, writeHandoffFile} = await import("../miniappFiles")

const DAY = 24 * 60 * 60 * 1000
let root: string
let own: InstanceType<typeof FakeDirectory>
let now: number
let clock: ReturnType<typeof spyOn>

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "miniapp-files-test-"))
  useFakeRoots(root)
  own = new FakeDirectory(FakePaths.document, "mentra_blobs", "p", "com.example.app")
  fs.mkdirSync(own.path, {recursive: true})
  crust.canonicalFilePath = crustRealpath
  now = 1_800_000_000_000
  clock = spyOn(Date, "now").mockImplementation(() => now)
})

afterEach(() => {
  clock.mockRestore()
  fs.rmSync(root, {recursive: true, force: true})
})

const handoffRoot = () => path.join(FakePaths.cache.path, "mentra_handoff")

describe("fileInside", () => {
  it("finds a file in the directory, by a plain or encoded URI", () => {
    fs.writeFileSync(path.join(own.path, "a b#1.wav"), "x")
    expect(fileInside(own, uriOf(path.join(own.path, "a b#1.wav")))?.exists).toBe(true)
    fs.mkdirSync(path.join(own.path, "sub"))
    fs.writeFileSync(path.join(own.path, "sub", "c.txt"), "x")
    expect(fileInside(own, uriOf(path.join(own.path, "sub", "c.txt")))?.exists).toBe(true)
  })

  it("is null for the directory itself, a missing file, a directory or another URI", () => {
    fs.mkdirSync(path.join(own.path, "sub"))
    expect(fileInside(own, own.uri)).toBeNull()
    expect(fileInside(own, uriOf(path.join(own.path, "missing.wav")))).toBeNull()
    expect(fileInside(own, uriOf(path.join(own.path, "sub")))).toBeNull()
    expect(fileInside(own, "https://example.com/a.wav")).toBeNull()
    expect(fileInside(own, path.join(own.path, "a.wav"))).toBeNull()
    expect(fileInside(own, 42)).toBeNull()
  })

  it("is null when nothing can resolve symlinks", () => {
    fs.writeFileSync(path.join(own.path, "a.wav"), "x")
    crust.canonicalFilePath = undefined
    expect(canonicalPath(own.path)).toBeNull()
    expect(fileInside(own, uriOf(path.join(own.path, "a.wav")))).toBeNull()
  })

  it("is null for a link that leads out of the directory", () => {
    const outside = path.join(root, "outside.txt")
    fs.writeFileSync(outside, "secret")
    fs.symlinkSync(outside, path.join(own.path, "link.txt"))
    fs.symlinkSync(root, path.join(own.path, "up"))
    expect(fileInside(own, uriOf(path.join(own.path, "link.txt")))).toBeNull()
    expect(fileInside(own, uriOf(path.join(own.path, "up", "outside.txt")))).toBeNull()
  })
})

describe("writeHandoffFile", () => {
  const write = (name: unknown) =>
    writeHandoffFile(name, "fallback.bin", (target) =>
      target.write(Buffer.from("bytes").toString("base64"), {encoding: "base64"}),
    )

  it("writes into a new directory of its own under the cache", async () => {
    const a = await write("../../x.txt")
    const b = await write("../../x.txt")
    for (const handoff of [a, b]) {
      const file = decodeURIComponent(handoff.file.uri.replace("file://", ""))
      expect(path.dirname(path.dirname(file))).toBe(handoffRoot())
      expect(path.basename(file)).toBe(".._.._x.txt")
      expect(fs.readFileSync(file, "utf8")).toBe("bytes")
    }
    expect(a.file.uri).not.toBe(b.file.uri)
  })

  it("refuses when the handoff directory is a link out of the cache, and leaves nothing behind", async () => {
    const elsewhere = path.join(root, "elsewhere")
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, handoffRoot())
    await expect(write("x.txt")).rejects.toThrow("outside the cache")
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it("refuses a write that landed somewhere else, and deletes its directory", async () => {
    const elsewhere = path.join(root, "elsewhere.txt")
    fs.writeFileSync(elsewhere, "x")
    await expect(
      writeHandoffFile(
        "x.txt",
        "x",
        () => new FakeDirectory(root).list().find((e) => e.name === "elsewhere.txt") as never,
      ),
    ).rejects.toThrow("outside its directory")
    expect(fs.readdirSync(handoffRoot())).toEqual([])
  })

  it("prunes handoffs older than a day unless a share sheet still has them", async () => {
    const old = await write("old.txt")
    const held = await write("held.txt")
    old.release()
    now += DAY + 1
    const fresh = await write("fresh.txt")
    const names = fs.readdirSync(handoffRoot())
    expect(names).toHaveLength(2)
    expect(fs.existsSync(decodeURIComponent(old.file.uri.replace("file://", "")))).toBe(false)
    expect(fs.existsSync(decodeURIComponent(held.file.uri.replace("file://", "")))).toBe(true)
    held.release()
    fresh.release()
  })
})

describe("linkedEntry", () => {
  let bundle: InstanceType<typeof FakeDirectory>
  beforeEach(() => {
    bundle = new FakeDirectory(FakePaths.cache, "lma_unzip-1")
    fs.mkdirSync(path.join(bundle.path, "ui", "assets"), {recursive: true})
    fs.writeFileSync(path.join(bundle.path, "miniapp.json"), "{}")
    fs.writeFileSync(path.join(bundle.path, "ui", "index.html"), "<html>")
    fs.writeFileSync(path.join(bundle.path, "ui", "assets", "app.js"), "1")
  })

  it("is null when every entry is a plain file or directory", () => {
    expect(linkedEntry(bundle)).toBeNull()
  })

  it("names a link to a file outside the bundle", () => {
    fs.writeFileSync(path.join(root, "secret"), "refresh-token")
    fs.symlinkSync(path.join(root, "secret"), path.join(bundle.path, "ui", "assets", "data.json"))
    expect(linkedEntry(bundle)).toBe("ui/assets/data.json")
  })

  it("names a link even when it points inside the bundle", () => {
    fs.symlinkSync(path.join(bundle.path, "miniapp.json"), path.join(bundle.path, "ui", "copy.json"))
    expect(linkedEntry(bundle)).toBe("ui/copy.json")
  })

  it("names a linked directory without entering it", () => {
    fs.mkdirSync(path.join(root, "outside"))
    fs.symlinkSync(path.join(root, "outside"), path.join(bundle.path, "ui", "docs"))
    const listed: string[] = []
    const list = FakeDirectory.prototype.list
    const spy = spyOn(FakeDirectory.prototype, "list").mockImplementation(function (
      this: InstanceType<typeof FakeDirectory>,
    ) {
      listed.push(this.path)
      return list.call(this)
    })
    try {
      expect(linkedEntry(bundle)).toBe("ui/docs")
      expect(listed).not.toContain(path.join(bundle.path, "ui", "docs"))
    } finally {
      spy.mockRestore()
    }
  })

  it("names a link to nothing", () => {
    fs.symlinkSync(path.join(root, "missing"), path.join(bundle.path, "miniapp.png"))
    expect(linkedEntry(bundle)).toBe("miniapp.png")
  })

  it("passes nothing when the host can't resolve paths, or the bundle's own directory", () => {
    crust.canonicalFilePath = undefined
    expect(linkedEntry(bundle)).toBe(".")
    crust.canonicalFilePath = crustRealpath
    expect(linkedEntry(new FakeDirectory(FakePaths.cache, "missing"))).toBe(".")
  })

  it("follows the real path of the directory the bundle is in", () => {
    // An iOS container is reached through /var, a link to /private/var.
    const linkedCache = path.join(root, "linked-cache")
    fs.symlinkSync(FakePaths.cache.path, linkedCache)
    expect(linkedEntry(new FakeDirectory(linkedCache, "lma_unzip-1"))).toBeNull()
  })
})
