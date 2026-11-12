import {afterEach, describe, expect, spyOn, test} from "bun:test"
import {createHash} from "node:crypto"
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {dirname, join} from "node:path"
import JSZip from "jszip"
import {publishMiniapp, readArchive, type ObjectStore} from "../../../.github/scripts/publish-miniapp-r2"
import {ServedMiniappManifestSchema} from "../../../cloud-v2/packages/protocol/src/miniapp-url"
import {verifySignedBundleArchive} from "./bundle-signing"
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

  test("keeps the previous archive and miniapp.json when zip creation fails", async () => {
    const cwd = createProject()
    const signingKey = generatePackageSigningKey("com.example.pack")
    const zipPath = await pack({cwd, silent: true, signingKey})
    const original = readFileSync(zipPath)
    const served = readFileSync(join(cwd, "build", "miniapp.json"))

    await expect(pack({cwd, silent: true, zipCommand: "/usr/bin/false", signingKey})).rejects.toThrow(
      "zip command failed",
    )
    expect(readFileSync(zipPath)).toEqual(original)
    expect(readFileSync(join(cwd, "build", "miniapp.json"))).toEqual(served)
  })

  test("replaces nothing when a later file can't be written", async () => {
    const cwd = createProject(scaffoldedManifest("com.example.pack", "1.0.0"))
    const zipPath = await pack({cwd, silent: true})
    const build = join(cwd, "build")
    const before = snapshot(build)

    // The same version again, now with an icon whose folder can't be made.
    writeFileSync(
      join(cwd, "miniapp.json"),
      JSON.stringify({...scaffoldedManifest("com.example.pack", "1.0.0"), icon: "assets/icon.png"}),
    )
    mkdirSync(join(cwd, "dist", "assets"))
    writeFileSync(join(cwd, "dist", "assets", "icon.png"), "new icon")
    writeFileSync(join(build, "assets"), "a file where the icon's folder would go")

    await expect(pack({cwd, silent: true})).rejects.toThrow()
    rmSync(join(build, "assets"))
    expect(snapshot(build)).toEqual(before)
    expect(JSON.parse(readFileSync(join(build, "miniapp.json"), "utf-8")).bundle.sha256).toBe(
      sha256(readFileSync(zipPath)),
    )
  })

  test("replaces nothing when a folder is where the icon goes", async () => {
    const cwd = createProject(scaffoldedManifest("com.example.pack", "1.0.0"))
    await pack({cwd, silent: true, zipCommand: quietZip()})
    const build = join(cwd, "build")
    rmSync(join(build, "icon.png"))
    mkdirSync(join(build, "icon.png"))
    writeFileSync(join(build, "icon.png", "inside"), "kept")
    const before = snapshot(build)

    writeFileSync(join(cwd, "dist", "index.js"), "export const changed = true")
    await expect(pack({cwd, silent: true})).rejects.toThrow("is a folder")
    expect(snapshot(build)).toEqual(before)
  })

  // Root can write to a read-only folder, so the failure can't be staged.
  test.skipIf(process.getuid?.() === 0)("puts the previous ZIP back when a later file can't be replaced", async () => {
    const cwd = createProject({...scaffoldedManifest("com.example.pack", "1.0.0"), icon: "assets/icon.png"})
    mkdirSync(join(cwd, "dist", "assets"))
    writeFileSync(join(cwd, "dist", "assets", "icon.png"), "icon")
    const zipPath = await pack({cwd, silent: true})
    const build = join(cwd, "build")
    const before = snapshot(build)

    writeFileSync(join(cwd, "dist", "index.js"), "export const changed = true")
    chmodSync(join(build, "assets"), 0o555)
    try {
      await expect(pack({cwd, silent: true})).rejects.toThrow()
    } finally {
      chmodSync(join(build, "assets"), 0o755)
    }
    expect(snapshot(build)).toEqual(before)
    expect(JSON.parse(readFileSync(join(build, "miniapp.json"), "utf-8")).bundle.sha256).toBe(
      sha256(readFileSync(zipPath)),
    )
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

describe("the folder pack writes", () => {
  test("holds the ZIP, its icon, and miniapp.json naming the ZIP and its hash", async () => {
    const manifest = scaffoldedManifest("com.example.notes", "1.4.2")
    const cwd = createProject(manifest)
    const zipPath = await pack({cwd, silent: true})
    const build = join(cwd, "build")

    expect(zipPath).toBe(join(build, "com.example.notes-1.4.2.zip"))
    expect(readdirSync(build).sort()).toEqual([".gitignore", "com.example.notes-1.4.2.zip", "icon.png", "miniapp.json"])

    const zipBytes = readFileSync(zipPath)
    const text = readFileSync(join(build, "miniapp.json"), "utf-8")
    const served = JSON.parse(text)
    expect(served).toEqual({...manifest, bundle: {url: "com.example.notes-1.4.2.zip", sha256: sha256(zipBytes)}})
    expect(text).toBe(`${JSON.stringify(served, null, 2)}\n`)
    expectServedManifest(served)

    // The ZIP's own miniapp.json is the served one without `bundle`.
    const zip = await JSZip.loadAsync(zipBytes)
    expect(JSON.parse(await zip.file("miniapp.json")!.async("string"))).toEqual(manifest)
    expect(readFileSync(join(build, "icon.png"))).toEqual(
      Buffer.from(await zip.file("icon.png")!.async("uint8array")),
    )
  })

  test("is what the first-party publisher writes to its host", async () => {
    const cwd = createProject(scaffoldedManifest("com.mentra.packcheck", "2.0.1"))
    const zipPath = await pack({cwd, silent: true})
    const host = memoryStore()

    const result = await publishMiniapp(readArchive(zipPath), host.store)

    expect(result.manifest).toBe("published")
    const build = join(cwd, "build")
    expect([...host.objects.keys()].sort()).toEqual([
      "com.mentra.packcheck/com.mentra.packcheck-2.0.1.zip",
      "com.mentra.packcheck/icon.png",
      "com.mentra.packcheck/miniapp.json",
    ])
    for (const [key, bytes] of host.objects) {
      const local = readFileSync(join(build, key.slice("com.mentra.packcheck/".length)))
      expect(Buffer.from(bytes)).toEqual(local)
    }
  })

  test("copies an icon from a folder in the bundle to the same path", async () => {
    const cwd = createProject({...scaffoldedManifest("com.example.pack", "1.0.0"), icon: "assets/app-icon.png"})
    mkdirSync(join(cwd, "dist", "assets"))
    writeFileSync(join(cwd, "dist", "assets", "app-icon.png"), "nested icon")

    await pack({cwd, silent: true})

    expect(readFileSync(join(cwd, "build", "assets", "app-icon.png"), "utf-8")).toBe("nested icon")
  })

  test("names no icon file when the icon is not in the bundle", async () => {
    const cwd = createProject({...scaffoldedManifest("com.example.pack", "1.0.0"), icon: "missing.png"})
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      await pack({cwd, silent: false, zipCommand: quietZip()})
      expect(warn.mock.calls.flat().join("\n")).toContain('icon "missing.png" is not in the bundle')
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
    expect(existsSync(join(cwd, "build", "missing.png"))).toBe(false)
    expect(JSON.parse(readFileSync(join(cwd, "build", "miniapp.json"), "utf-8")).icon).toBe("missing.png")
  })

  test("removes an earlier pack's icon that the new ZIP doesn't have", async () => {
    const cwd = createProject({...scaffoldedManifest("com.example.pack", "1.0.0"), icon: "assets/icon.png"})
    mkdirSync(join(cwd, "dist", "assets"))
    writeFileSync(join(cwd, "dist", "assets", "icon.png"), "icon")
    await pack({cwd, silent: true})
    expect(existsSync(join(cwd, "build", "assets", "icon.png"))).toBe(true)

    rmSync(join(cwd, "dist", "assets", "icon.png"))
    await pack({cwd, silent: true})
    expect(existsSync(join(cwd, "build", "assets", "icon.png"))).toBe(false)
  })

  test("never removes the folder's own files for an icon the ZIP doesn't have", async () => {
    for (const icon of ["./miniapp.json", "MINIAPP.JSON", "./.gitignore", "./com.example.pack-1.0.0.zip"]) {
      const cwd = createProject({...scaffoldedManifest("com.example.pack", "1.0.0"), icon})
      await pack({cwd, silent: true})
      const build = join(cwd, "build")
      expect(JSON.parse(readFileSync(join(build, "miniapp.json"), "utf-8")).icon).toBe(icon)
      expect(existsSync(join(build, ".gitignore"))).toBe(true)
      expect(existsSync(join(build, "com.example.pack-1.0.0.zip"))).toBe(true)
    }
  })

  test("leaves an icon on another host to that host", async () => {
    const cwd = createProject({...scaffoldedManifest("com.example.pack", "1.0.0"), icon: "https://cdn.example.com/i.png"})
    await pack({cwd, silent: true})
    expect(readdirSync(join(cwd, "build")).sort()).toEqual([".gitignore", "com.example.pack-1.0.0.zip", "miniapp.json"])
  })

  test("keeps older ZIPs, and miniapp.json names the newest", async () => {
    const cwd = createProject(scaffoldedManifest("com.example.pack", "1.0.0"))
    await pack({cwd, silent: true})
    writeFileSync(join(cwd, "miniapp.json"), JSON.stringify(scaffoldedManifest("com.example.pack", "1.0.1")))
    const zipPath = await pack({cwd, silent: true})

    const build = join(cwd, "build")
    expect(existsSync(join(build, "com.example.pack-1.0.0.zip"))).toBe(true)
    const served = JSON.parse(readFileSync(join(build, "miniapp.json"), "utf-8"))
    expect(served.version).toBe("1.0.1")
    expect(served.bundle).toEqual({url: "com.example.pack-1.0.1.zip", sha256: sha256(readFileSync(zipPath))})
  })

  test("names the signed ZIP's hash for a signed pack", async () => {
    const cwd = createProject(scaffoldedManifest("com.example.pack", "1.0.0"))
    const signingKey = generatePackageSigningKey("com.example.pack")
    const zipPath = await pack({cwd, silent: true, sign: true, signingKey})

    const zipBytes = readFileSync(zipPath)
    const verified = await verifySignedBundleArchive(new Uint8Array(zipBytes))
    expect(verified.packageName).toBe("com.example.pack")
    const served = JSON.parse(readFileSync(join(cwd, "build", "miniapp.json"), "utf-8"))
    expect(served.bundle).toEqual({url: "com.example.pack-1.0.0.zip", sha256: sha256(zipBytes)})
    expectServedManifest(served)
  })

  test("refuses a miniapp.json that already declares a bundle", async () => {
    const cwd = createProject({
      ...scaffoldedManifest("com.example.pack", "1.0.0"),
      bundle: {url: "bundle.zip", sha256: "0".repeat(64)},
    })
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as typeof process.exit)
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(pack({cwd, silent: true})).rejects.toThrow("exit 1")
      expect(error.mock.calls.flat().join("\n")).toContain("must not declare bundle")
    } finally {
      exit.mockRestore()
      error.mockRestore()
    }
    expect(existsSync(join(cwd, "build"))).toBe(false)
  })

  test("tells the developer to upload the folder", async () => {
    const cwd = createProject(scaffoldedManifest("com.example.pack", "1.0.0"))
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      await pack({cwd, silent: false, zipCommand: quietZip()})
      expect(log.mock.calls.flat()).toContain("Upload the build folder to your miniapp's URL.")
    } finally {
      log.mockRestore()
    }
  })
})

/** A manifest shaped like the one create-mentra-miniapp scaffolds. */
function scaffoldedManifest(packageName: string, version: string): Record<string, unknown> {
  return {
    $schema: "./node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json",
    packageName,
    version,
    name: "Notes",
    description: "Take notes with your voice.",
    icon: "icon.png",
    type: "standard",
    sdkVersion: "0.3.0",
    minHostVersion: "1.42.0",
    entry: {background: "background/index.js", ui: "ui/index.html"},
    permissions: [{type: "MICROPHONE", required: true}],
    hardwareRequirements: [{type: "MICROPHONE", level: "REQUIRED"}],
  }
}

function createProject(
  manifest: Record<string, unknown> = {
    packageName: "com.example.pack",
    version: "1.0.0",
    name: "Pack Test",
    permissions: [],
    hardwareRequirements: [],
  },
): string {
  const cwd = mkdtempSync(join(tmpdir(), "mentra-pack-"))
  dirs.push(cwd)
  mkdirSync(join(cwd, "dist"))
  writeFileSync(join(cwd, "miniapp.json"), JSON.stringify(manifest))
  writeFileSync(join(cwd, "dist", "index.js"), "export {}")
  const entry = manifest.entry as {background?: string; ui?: string} | undefined
  for (const path of [entry?.background, entry?.ui]) {
    if (!path) continue
    mkdirSync(dirname(join(cwd, "dist", path)), {recursive: true})
    writeFileSync(join(cwd, "dist", path), "export {}")
  }
  if (manifest.icon === "icon.png") writeFileSync(join(cwd, "icon.png"), "project icon")
  return cwd
}

/** `zip`, without its per-file output, for tests that print. */
function quietZip(): string {
  const dir = mkdtempSync(join(tmpdir(), "mentra-pack-zip-"))
  dirs.push(dir)
  const path = join(dir, "zip")
  writeFileSync(path, '#!/bin/sh\nexec zip -q "$@"\n', {mode: 0o755})
  return path
}

function memoryStore(): {store: ObjectStore; objects: Map<string, Uint8Array>} {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    store: {
      exists: async (key) => objects.has(key),
      read: async (key) => objects.get(key)!,
      write: async (key, data) => {
        objects.set(key, typeof data === "string" ? new TextEncoder().encode(data) : data)
      },
    },
  }
}

/** Every file under `dir`, hidden ones included, with its content. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(dir, {recursive: true, withFileTypes: true})) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[path.slice(dir.length + 1)] = sha256(readFileSync(path))
  }
  return files
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** What Core and the engine accept as a served miniapp.json. */
function expectServedManifest(served: Record<string, unknown>): void {
  const parsed = ServedMiniappManifestSchema.safeParse(served)
  expect(parsed.error?.issues ?? []).toEqual([])
  expect(parsed.data?.bundle.url).toBe(`${served.packageName}-${served.version}.zip`)
}
