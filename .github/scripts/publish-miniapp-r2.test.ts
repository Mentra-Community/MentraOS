import {describe, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {
  archiveFromBytes,
  type MiniappArchive,
  type ObjectStore,
  publishMiniapp,
  readArchive,
} from "./publish-miniapp-r2"

function memoryStore() {
  const objects = new Map<string, {data: Uint8Array; type: string}>()
  const store: ObjectStore = {
    exists: async (key) => objects.has(key),
    read: async (key) => objects.get(key)!.data,
    write: async (key, data, type) => {
      objects.set(key, {data: typeof data === "string" ? new TextEncoder().encode(data) : data, type})
    },
  }
  const json = (key: string) => JSON.parse(new TextDecoder().decode(objects.get(key)!.data))
  return {store, objects, json}
}

function archive(version: string, extra: Record<string, unknown> = {}, bytes = `zip-${version}`): MiniappArchive {
  const manifest = {packageName: "com.mentra.captions", version, name: "Captions", icon: "icon.png", ...extra}
  return {
    bytes: new TextEncoder().encode(bytes),
    manifest: JSON.stringify(manifest),
    file: (path) => (path === "icon.png" ? new TextEncoder().encode("png") : null),
  }
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** Opens a stored test ZIP: its bytes are `zip-<version>`. */
const openStored = (bytes: Uint8Array) => archive(new TextDecoder().decode(bytes).replace(/^zip-/, ""))

describe("publishing a miniapp to its own URL", () => {
  test("uploads the ZIP, the icon, and miniapp.json naming the ZIP and its hash", async () => {
    const {store, objects, json} = memoryStore()
    const result = await publishMiniapp(archive("1.2.0"), store)
    expect(result.manifest).toBe("published")
    expect([...objects.keys()].sort()).toEqual([
      "com.mentra.captions/com.mentra.captions-1.2.0.zip",
      "com.mentra.captions/icon.png",
      "com.mentra.captions/miniapp.json",
    ])
    expect(json("com.mentra.captions/miniapp.json")).toEqual({
      packageName: "com.mentra.captions",
      version: "1.2.0",
      name: "Captions",
      icon: "icon.png",
      bundle: {url: "com.mentra.captions-1.2.0.zip", sha256: sha("zip-1.2.0")},
    })
    expect(objects.get("com.mentra.captions/miniapp.json")!.type).toBe("application/json")
    expect(objects.get("com.mentra.captions/com.mentra.captions-1.2.0.zip")!.type).toBe("application/zip")
  })

  test("a version the host already has is skipped, and its ZIP never changes", async () => {
    const {store, objects} = memoryStore()
    await publishMiniapp(archive("1.2.0"), store)
    const result = await publishMiniapp(archive("1.2.0", {}, "rebuilt bytes"), store)
    expect(result.manifest).toBe("already-published")
    expect(new TextDecoder().decode(objects.get("com.mentra.captions/com.mentra.captions-1.2.0.zip")!.data)).toBe(
      "zip-1.2.0",
    )
  })

  test("never moves miniapp.json back to an older version, or uploads its ZIP", async () => {
    const {store, objects, json} = memoryStore()
    await publishMiniapp(archive("1.3.0"), store)
    const result = await publishMiniapp(archive("1.2.9"), store)
    expect(result.manifest).toBe("kept-newer")
    expect(json("com.mentra.captions/miniapp.json").version).toBe("1.3.0")
    expect(objects.has("com.mentra.captions/com.mentra.captions-1.2.9.zip")).toBe(false)
  })

  test("a newer version replaces miniapp.json and keeps the older ZIP", async () => {
    const {store, objects, json} = memoryStore()
    await publishMiniapp(archive("1.2.0"), store)
    await publishMiniapp(archive("1.10.0"), store)
    expect(json("com.mentra.captions/miniapp.json").version).toBe("1.10.0")
    expect(objects.has("com.mentra.captions/com.mentra.captions-1.2.0.zip")).toBe(true)
  })

  test("a publish interrupted after its ZIP is finished from the stored ZIP, never a rebuild", async () => {
    const {store, objects, json} = memoryStore()
    let failManifest = true
    const flaky: ObjectStore = {
      ...store,
      write: async (key, data, type) => {
        if (key.endsWith("/miniapp.json") && failManifest) throw new Error("connection reset")
        await store.write(key, data, type)
      },
    }
    await expect(publishMiniapp(archive("1.2.0"), flaky, openStored)).rejects.toThrow("connection reset")
    expect(objects.has("com.mentra.captions/miniapp.json")).toBe(false)
    failManifest = false
    const result = await publishMiniapp(archive("1.2.0", {}, "rebuilt bytes"), flaky, openStored)
    expect(result.manifest).toBe("published")
    expect(json("com.mentra.captions/miniapp.json").bundle).toEqual({
      url: "com.mentra.captions-1.2.0.zip",
      sha256: sha("zip-1.2.0"),
    })
    expect(new TextDecoder().decode(objects.get("com.mentra.captions/com.mentra.captions-1.2.0.zip")!.data)).toBe(
      "zip-1.2.0",
    )
  })

  test.each([
    ["a third-party package", {packageName: "com.example.notes"}],
    ["a prerelease version", {version: "1.2.0-dev.1"}],
    ["a ZIP that already declares a bundle", {bundle: {url: "x.zip", sha256: "a"}}],
  ])("refuses %s", async (_name, extra) => {
    const {store} = memoryStore()
    const bad = archive("1.2.0")
    bad.manifest = JSON.stringify({...JSON.parse(bad.manifest), ...extra})
    await expect(publishMiniapp(bad, store)).rejects.toThrow()
  })

  test("reads miniapp.json and the icon from a real ZIP", () => {
    const dir = mkdtempSync(join(tmpdir(), "publish-miniapp-"))
    writeFileSync(join(dir, "miniapp.json"), JSON.stringify({packageName: "com.mentra.captions", version: "1.0.0"}))
    writeFileSync(join(dir, "icon.png"), "png")
    const zip = join(dir, "bundle.zip")
    expect(Bun.spawnSync(["zip", "-q", zip, "miniapp.json", "icon.png"], {cwd: dir}).exitCode).toBe(0)
    const read = readArchive(zip)
    expect(JSON.parse(read.manifest).version).toBe("1.0.0")
    expect(new TextDecoder().decode(read.file("icon.png")!)).toBe("png")
    expect(read.file("missing.png")).toBeNull()
    const stored = archiveFromBytes(read.bytes)
    expect(JSON.parse(stored.manifest).version).toBe("1.0.0")
    expect(new TextDecoder().decode(stored.file("icon.png")!)).toBe("png")
  })
})
