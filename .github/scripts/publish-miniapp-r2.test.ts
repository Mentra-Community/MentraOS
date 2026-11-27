import {describe, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {
  compareVersions,
  listedVersions,
  mergeVersions,
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
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** The key of a test ZIP: its name carries the first 8 hex digits of its SHA-256. */
const zipName = (version: string, bytes = `zip-${version}`) =>
  `com.mentra.captions-${version}-${sha(bytes).slice(0, 8)}.zip`
const zipKey = (version: string, bytes?: string) => `com.mentra.captions/${zipName(version, bytes)}`
/** The `versions` entry of a test ZIP. */
const entry = (version: string, bytes = `zip-${version}`) => ({
  version,
  url: zipName(version, bytes),
  sha256: sha(bytes),
})

describe("publishing a miniapp to its own URL", () => {
  test("uploads the ZIP, the icon, and miniapp.json naming the ZIP and its hash", async () => {
    const {store, objects, json} = memoryStore()
    const result = await publishMiniapp(archive("1.2.0"), store)
    expect(result.manifest).toBe("published")
    expect(result.zipKey).toBe(zipKey("1.2.0"))
    expect(zipKey("1.2.0")).toMatch(/^com\.mentra\.captions\/com\.mentra\.captions-1\.2\.0-[0-9a-f]{8}\.zip$/)
    expect([...objects.keys()].sort()).toEqual(
      [zipKey("1.2.0"), "com.mentra.captions/icon.png", "com.mentra.captions/miniapp.json"].sort(),
    )
    expect(json("com.mentra.captions/miniapp.json")).toEqual({
      packageName: "com.mentra.captions",
      version: "1.2.0",
      name: "Captions",
      icon: "icon.png",
      bundle: {url: zipName("1.2.0"), sha256: sha("zip-1.2.0")},
      versions: [entry("1.2.0")],
    })
    expect(objects.get("com.mentra.captions/miniapp.json")!.type).toBe("application/json")
    expect(objects.get(zipKey("1.2.0"))!.type).toBe("application/zip")
  })

  test("miniapp.json is written last, after the ZIP and the icon", async () => {
    const {store} = memoryStore()
    const written: string[] = []
    const recording: ObjectStore = {
      ...store,
      write: async (key, data, type) => {
        written.push(key)
        await store.write(key, data, type)
      },
    }
    await publishMiniapp(archive("1.2.0"), recording)
    expect(written).toEqual([zipKey("1.2.0"), "com.mentra.captions/icon.png", "com.mentra.captions/miniapp.json"])
  })

  test("the build the host already serves is nothing to do", async () => {
    const {store, objects} = memoryStore()
    await publishMiniapp(archive("1.2.0"), store)
    const before = new Map(objects)
    const written: string[] = []
    const result = await publishMiniapp(archive("1.2.0"), {
      ...store,
      write: async (key) => {
        written.push(key)
      },
    })
    expect(result.manifest).toBe("already-published")
    expect(result.zipKey).toBe(zipKey("1.2.0"))
    expect(written).toEqual([])
    expect(objects).toEqual(before)
  })

  test("other bytes under the version the host has are published, beside the earlier build's ZIP", async () => {
    const {store, objects, json} = memoryStore()
    await publishMiniapp(archive("1.2.0"), store)
    const result = await publishMiniapp(archive("1.2.0", {}, "rebuilt bytes"), store)
    expect(result.manifest).toBe("published")
    expect(json("com.mentra.captions/miniapp.json")).toMatchObject({
      version: "1.2.0",
      bundle: {url: zipName("1.2.0", "rebuilt bytes"), sha256: sha("rebuilt bytes")},
    })
    // No ZIP is ever overwritten: the earlier build's stays as it was, for phones and caches that have its name.
    expect(text(objects.get(zipKey("1.2.0"))!.data)).toBe("zip-1.2.0")
    expect(text(objects.get(zipKey("1.2.0", "rebuilt bytes"))!.data)).toBe("rebuilt bytes")
  })

  test("a lower version than the host has is published like any other: versions are not compared", async () => {
    const {store, objects, json} = memoryStore()
    await publishMiniapp(archive("1.3.0"), store)
    const result = await publishMiniapp(archive("1.2.9"), store)
    expect(result.manifest).toBe("published")
    expect(json("com.mentra.captions/miniapp.json")).toMatchObject({
      version: "1.2.9",
      bundle: {url: zipName("1.2.9"), sha256: sha("zip-1.2.9")},
    })
    expect(objects.has(zipKey("1.2.9"))).toBe(true)
    expect(objects.has(zipKey("1.3.0"))).toBe(true)
  })

  test("publishing an earlier build again points miniapp.json back at its ZIP, which is not uploaded again", async () => {
    const {store, json} = memoryStore()
    await publishMiniapp(archive("1.2.0"), store)
    await publishMiniapp(archive("1.3.0"), store)
    const written: string[] = []
    const result = await publishMiniapp(archive("1.2.0"), {
      ...store,
      write: async (key, data, type) => {
        written.push(key)
        await store.write(key, data, type)
      },
    })
    expect(result.manifest).toBe("published")
    expect(written).toEqual(["com.mentra.captions/icon.png", "com.mentra.captions/miniapp.json"])
    expect(json("com.mentra.captions/miniapp.json").bundle).toEqual({url: zipName("1.2.0"), sha256: sha("zip-1.2.0")})
  })

  test("a newer version replaces miniapp.json and keeps the older ZIP", async () => {
    const {store, objects, json} = memoryStore()
    await publishMiniapp(archive("1.2.0"), store)
    await publishMiniapp(archive("1.10.0"), store)
    expect(json("com.mentra.captions/miniapp.json").version).toBe("1.10.0")
    expect(objects.has(zipKey("1.2.0"))).toBe(true)
  })

  test("a host published before ZIP names carried a hash: the build it serves is skipped, another is published", async () => {
    const {store, objects, json} = memoryStore()
    const oldKey = "com.mentra.captions/com.mentra.captions-1.2.0.zip"
    await store.write(oldKey, new TextEncoder().encode("zip-1.2.0"), "application/zip")
    await store.write(
      "com.mentra.captions/miniapp.json",
      JSON.stringify({
        packageName: "com.mentra.captions",
        version: "1.2.0",
        name: "Captions",
        bundle: {url: "com.mentra.captions-1.2.0.zip", sha256: sha("zip-1.2.0")},
      }),
      "application/json",
    )
    // The build is not uploaded again and stays under the name the host has it by. Its miniapp.json, written
    // before the versions list existed, gains the list.
    const written: string[] = []
    const recording: ObjectStore = {
      ...store,
      write: async (key, data, type) => {
        written.push(key)
        await store.write(key, data, type)
      },
    }
    const same = await publishMiniapp(archive("1.2.0"), recording)
    expect(same.manifest).toBe("versions-listed")
    expect(same.zipKey).toBe(oldKey)
    expect(written).toEqual(["com.mentra.captions/miniapp.json"])
    expect(json("com.mentra.captions/miniapp.json")).toEqual({
      packageName: "com.mentra.captions",
      version: "1.2.0",
      name: "Captions",
      bundle: {url: "com.mentra.captions-1.2.0.zip", sha256: sha("zip-1.2.0")},
      versions: [{version: "1.2.0", url: "com.mentra.captions-1.2.0.zip", sha256: sha("zip-1.2.0")}],
    })
    const again = await publishMiniapp(archive("1.2.0"), recording)
    expect(again.manifest).toBe("already-published")
    expect(again.zipKey).toBe(oldKey)
    expect(written).toHaveLength(1)

    const rebuilt = await publishMiniapp(archive("1.2.0", {}, "rebuilt bytes"), store)
    expect(rebuilt.manifest).toBe("published")
    expect(json("com.mentra.captions/miniapp.json").bundle.url).toBe(zipName("1.2.0", "rebuilt bytes"))
    expect(text(objects.get(oldKey)!.data)).toBe("zip-1.2.0")
  })

  test("a publish interrupted after its ZIP is finished from the stored ZIP, which is not uploaded again", async () => {
    const {store, objects, json} = memoryStore()
    let failManifest = true
    const written: string[] = []
    const flaky: ObjectStore = {
      ...store,
      write: async (key, data, type) => {
        if (key.endsWith("/miniapp.json") && failManifest) throw new Error("connection reset")
        written.push(key)
        await store.write(key, data, type)
      },
    }
    await expect(publishMiniapp(archive("1.2.0"), flaky)).rejects.toThrow("connection reset")
    expect(objects.has("com.mentra.captions/miniapp.json")).toBe(false)
    expect(objects.has(zipKey("1.2.0"))).toBe(true)
    failManifest = false
    written.length = 0
    const result = await publishMiniapp(archive("1.2.0"), flaky)
    expect(result.manifest).toBe("published")
    expect(written).toEqual(["com.mentra.captions/icon.png", "com.mentra.captions/miniapp.json"])
    expect(json("com.mentra.captions/miniapp.json").bundle).toEqual({
      url: zipName("1.2.0"),
      sha256: sha("zip-1.2.0"),
    })
    expect(text(objects.get(zipKey("1.2.0"))!.data)).toBe("zip-1.2.0")
  })

  test("a rebuild after an interrupted publish is published under its own name; the interrupted build's ZIP stays", async () => {
    const {store, objects, json} = memoryStore()
    let failManifest = true
    const flaky: ObjectStore = {
      ...store,
      write: async (key, data, type) => {
        if (key.endsWith("/miniapp.json") && failManifest) throw new Error("connection reset")
        await store.write(key, data, type)
      },
    }
    await expect(publishMiniapp(archive("1.2.0"), flaky)).rejects.toThrow("connection reset")
    failManifest = false
    const result = await publishMiniapp(archive("1.2.0", {}, "rebuilt bytes"), flaky)
    expect(result.manifest).toBe("published")
    expect(json("com.mentra.captions/miniapp.json").bundle).toEqual({
      url: zipName("1.2.0", "rebuilt bytes"),
      sha256: sha("rebuilt bytes"),
    })
    expect(text(objects.get(zipKey("1.2.0"))!.data)).toBe("zip-1.2.0")
  })

  test("never overwrites a stored ZIP: other bytes at this build's key stop the publish", async () => {
    const {store, objects} = memoryStore()
    await store.write(zipKey("1.2.0"), new TextEncoder().encode("something else"), "application/zip")
    await expect(publishMiniapp(archive("1.2.0"), store)).rejects.toThrow("holds another build")
    expect(text(objects.get(zipKey("1.2.0"))!.data)).toBe("something else")
    expect(objects.has("com.mentra.captions/miniapp.json")).toBe(false)
  })

  test.each([
    ["a third-party package", {packageName: "com.example.notes"}],
    ["a prerelease version", {version: "1.2.0-dev.1"}],
    ["a ZIP that already declares a bundle", {bundle: {url: "x.zip", sha256: "a"}}],
    ["a ZIP that already declares versions", {versions: []}],
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
  })
})

describe("versions: the versions a phone can be pinned to", () => {
  const manifestKey = "com.mentra.captions/miniapp.json"

  test("each publish adds its version and keeps the others, highest version first", async () => {
    const {store, json} = memoryStore()
    await publishMiniapp(archive("1.2.0"), store)
    await publishMiniapp(archive("1.10.0"), store)
    await publishMiniapp(archive("1.9.3"), store)
    expect(json(manifestKey).versions).toEqual([entry("1.10.0"), entry("1.9.3"), entry("1.2.0")])
    // `bundle` is the build published last, whatever its version.
    expect(json(manifestKey).bundle).toEqual({url: zipName("1.9.3"), sha256: sha("zip-1.9.3")})
  })

  test("every listed version's ZIP is on the host, with the bytes its entry names", async () => {
    const {store, objects, json} = memoryStore()
    for (const version of ["1.0.0", "1.1.0", "1.0.5", "2.0.0", "1.1.0"]) {
      await publishMiniapp(archive(version), store)
    }
    const versions = json(manifestKey).versions as Array<{version: string; url: string; sha256: string}>
    expect(versions.map((listed) => listed.version)).toEqual(["2.0.0", "1.1.0", "1.0.5", "1.0.0"])
    for (const listed of versions) {
      expect(sha(text(objects.get(`com.mentra.captions/${listed.url}`)!.data))).toBe(listed.sha256)
    }
  })

  test("other bytes under a listed version replace its entry; the earlier build's ZIP stays", async () => {
    const {store, objects, json} = memoryStore()
    await publishMiniapp(archive("1.2.0"), store)
    await publishMiniapp(archive("1.3.0"), store)
    await publishMiniapp(archive("1.2.0", {}, "rebuilt bytes"), store)
    // One entry per version: a phone pinned to 1.2.0 with the earlier hash sees that it changed.
    expect(json(manifestKey).versions).toEqual([entry("1.3.0"), entry("1.2.0", "rebuilt bytes")])
    expect(text(objects.get(zipKey("1.2.0"))!.data)).toBe("zip-1.2.0")
  })

  test("a lower version published after a higher one becomes the build served, and both stay listed", async () => {
    const {store, json} = memoryStore()
    await publishMiniapp(archive("1.3.0"), store)
    await publishMiniapp(archive("1.2.9"), store)
    expect(json(manifestKey).version).toBe("1.2.9")
    expect(json(manifestKey).versions).toEqual([entry("1.3.0"), entry("1.2.9")])
  })

  test("a miniapp.json published before the list existed keeps the build it serves when another is published", async () => {
    const {store, json} = memoryStore()
    await store.write(zipKey("1.2.0"), new TextEncoder().encode("zip-1.2.0"), "application/zip")
    await store.write(
      manifestKey,
      JSON.stringify({
        packageName: "com.mentra.captions",
        version: "1.2.0",
        name: "Captions",
        bundle: {url: zipName("1.2.0"), sha256: sha("zip-1.2.0").toUpperCase()},
      }),
      "application/json",
    )
    await publishMiniapp(archive("1.3.0"), store)
    expect(json(manifestKey).versions).toEqual([entry("1.3.0"), entry("1.2.0")])
  })

  test("the build the host serves gains the list without being published again, once", async () => {
    const {store, objects, json} = memoryStore()
    await publishMiniapp(archive("1.2.0"), store)
    const live = json(manifestKey)
    delete live.versions
    await store.write(manifestKey, JSON.stringify(live), "application/json")

    const written: string[] = []
    const recording: ObjectStore = {
      ...store,
      write: async (key, data, type) => {
        written.push(key)
        await store.write(key, data, type)
      },
    }
    const result = await publishMiniapp(archive("1.2.0"), recording)
    expect(result.manifest).toBe("versions-listed")
    expect(result.zipKey).toBe(zipKey("1.2.0"))
    expect(written).toEqual([manifestKey])
    // Nothing else of miniapp.json changes: no phone sees another build.
    expect(json(manifestKey)).toEqual({...live, versions: [entry("1.2.0")]})
    expect(objects.get(manifestKey)!.type).toBe("application/json")

    expect((await publishMiniapp(archive("1.2.0"), recording)).manifest).toBe("already-published")
    expect(written).toEqual([manifestKey])
  })

  test("a dry run, which drops every write, reports the list it would add and changes nothing", async () => {
    const {store, objects} = memoryStore()
    await publishMiniapp(archive("1.2.0"), store)
    const live = JSON.parse(text(objects.get(manifestKey)!.data))
    delete live.versions
    await store.write(manifestKey, JSON.stringify(live), "application/json")
    const before = new Map(objects)

    const writes: string[] = []
    const readOnly: ObjectStore = {
      ...store,
      write: async (key) => {
        writes.push(key)
      },
    }
    expect((await publishMiniapp(archive("1.2.0"), readOnly)).manifest).toBe("versions-listed")
    expect(writes).toEqual([manifestKey])
    expect((await publishMiniapp(archive("1.3.0"), readOnly)).manifest).toBe("published")
    expect(objects).toEqual(before)
  })

  test("keeps the 50 highest versions, and always the one it publishes", async () => {
    const {store, json} = memoryStore()
    const sixty = Array.from({length: 60}, (_, index) => ({
      version: `1.${index}.0`,
      url: `com.mentra.captions-1.${index}.0-00000000.zip`,
      sha256: "0".repeat(64),
    }))
    await store.write(
      manifestKey,
      JSON.stringify({packageName: "com.mentra.captions", version: "1.59.0", versions: sixty}),
      "application/json",
    )
    await publishMiniapp(archive("2.0.0"), store)
    let versions = (json(manifestKey).versions as Array<{version: string}>).map((listed) => listed.version)
    expect(versions).toHaveLength(50)
    expect(versions[0]).toBe("2.0.0")
    expect(versions[1]).toBe("1.59.0")
    expect(versions[49]).toBe("1.11.0")

    // A rollback to a version below all 50: it is the build served, so it is listed.
    await publishMiniapp(archive("0.9.0"), store)
    versions = (json(manifestKey).versions as Array<{version: string}>).map((listed) => listed.version)
    expect(versions).toHaveLength(50)
    expect(versions[0]).toBe("2.0.0")
    expect(versions[48]).toBe("1.12.0")
    expect(versions[49]).toBe("0.9.0")
  })

  test("refuses to publish over a list it can't read, and writes nothing", async () => {
    for (const versions of [{}, "1.2.0", [{version: "1.2.0"}], [{version: "one", url: "a.zip", sha256: "0".repeat(64)}]]) {
      const {store, objects} = memoryStore()
      await store.write(
        manifestKey,
        JSON.stringify({packageName: "com.mentra.captions", version: "1.2.0", versions}),
        "application/json",
      )
      const before = new Map(objects)
      await expect(publishMiniapp(archive("1.3.0"), store)).rejects.toThrow("com.mentra.captions/miniapp.json: versions")
      expect(objects).toEqual(before)
    }
  })

  test("orders by SemVer precedence: numbers as numbers, a prerelease below its release", () => {
    const ascending = [
      "0.9.9",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.0+build.2",
      "1.2.0",
      "1.10.0",
      "2.0.0",
      "10.0.0",
    ]
    const shuffled = [...ascending].sort((a, b) => sha(a).localeCompare(sha(b)))
    expect(shuffled.sort(compareVersions)).toEqual(ascending)
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0)
  })

  test("a list reads as its entries, lowercased hashes; none yet reads as the build served", () => {
    const upper = "AB".repeat(32)
    expect(listedVersions({versions: [{version: "1.0.0", url: "a.zip", sha256: upper, extra: true}]})).toEqual([
      {version: "1.0.0", url: "a.zip", sha256: upper.toLowerCase()},
    ])
    expect(listedVersions({versions: []})).toEqual([])
    expect(listedVersions({version: "1.0.0", bundle: {url: "a.zip", sha256: upper}})).toEqual([
      {version: "1.0.0", url: "a.zip", sha256: upper.toLowerCase()},
    ])
    expect(listedVersions({version: "1.0.0"})).toEqual([])
    const listed = [{version: "1.0.0", url: "a.zip", sha256: "0".repeat(64)}]
    expect(mergeVersions([...listed, {...listed[0]!, url: "duplicate.zip"}], listed[0]!)).toEqual(listed)
  })
})
