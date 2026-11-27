import {afterEach, describe, expect, setSystemTime, spyOn, test} from "bun:test"
import {createHash} from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import {tmpdir} from "node:os"
import {dirname, join} from "node:path"
import JSZip from "jszip"
import {publishMiniapp, readArchive, type ObjectStore} from "../../../.github/scripts/publish-miniapp-r2"
import {ServedMiniappManifestSchema} from "../../../cloud-v2/packages/protocol/src/miniapp-url"
import {verifySignedBundleArchive} from "./bundle-signing"
import {pack, packedZipName, packedZipPath} from "./pack"
import {generatePackageSigningKey} from "./package-signing-key"

const dirs: string[] = []
afterEach(() => {
  setSystemTime()
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true})
})

describe("pack", () => {
  test("records the API level of the project's @mentra/miniapp as minApiLevel", async () => {
    const cwd = createProject()
    mkdirSync(join(cwd, "node_modules", "@mentra", "miniapp"), {recursive: true})
    writeFileSync(join(cwd, "node_modules", "@mentra", "miniapp", "package.json"), JSON.stringify({apiLevel: 7}))
    const zipPath = await pack({cwd, silent: true})

    const zip = await JSZip.loadAsync(readFileSync(zipPath))
    expect(JSON.parse(await zip.file("miniapp.json")!.async("string")).minApiLevel).toBe(7)
    expect(JSON.parse(readFileSync(join(cwd, "build", "miniapp.json"), "utf-8")).minApiLevel).toBe(7)
  })

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
    await pack({cwd, silent: true, signingKey})

    rmSync(join(cwd, "dist", "old.js"))
    writeFileSync(join(cwd, "dist", "new.js"), "new")
    const zipPath = await pack({cwd, silent: true, signingKey})

    const zip = await JSZip.loadAsync(await Bun.file(zipPath).arrayBuffer())
    expect(zip.file("new.js")).not.toBeNull()
    expect(zip.file("old.js")).toBeNull()
  })

  test("keeps the previous archive and miniapp.json when the ZIP can't be made", async () => {
    const cwd = createProject()
    const signingKey = generatePackageSigningKey("com.example.pack")
    await pack({cwd, silent: true, signingKey})
    const before = snapshot(join(cwd, "build"))

    // A file the pack can't read: a link to nothing.
    symlinkSync(join(cwd, "missing.js"), join(cwd, "dist", "broken.js"))
    await expect(pack({cwd, silent: true, signingKey})).rejects.toThrow("dist/broken.js can't be read")
    expect(snapshot(join(cwd, "build"))).toEqual(before)
  })

  test("writes nothing when a first pack fails", async () => {
    const cwd = createProject()
    symlinkSync(join(cwd, "missing.js"), join(cwd, "dist", "broken.js"))
    await expect(pack({cwd, silent: true})).rejects.toThrow("can't be read")
    expect(existsSync(join(cwd, "build"))).toBe(false)
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
    await pack({cwd, silent: true})
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

describe("the same files always pack to the same ZIP", () => {
  /** A project with nested folders, written in an order that isn't the names'. */
  function project(): string {
    const cwd = createProject(scaffoldedManifest("com.example.pack", "1.0.0"))
    mkdirSync(join(cwd, "dist", "ui", "assets"), {recursive: true})
    for (const [path, text] of [
      ["ui/assets/z.css", "body {}"],
      ["ui/assets/a.js", "export const a = 1"],
      ["zeta.js", "export const zeta = 1"],
      ["alpha.js", "export const alpha = 1"],
    ]) {
      writeFileSync(join(cwd, "dist", path), text)
    }
    return cwd
  }

  /** Give every file and folder of the project another modification time. */
  function touchAll(cwd: string, at: Date): void {
    for (const entry of readdirSync(cwd, {recursive: true, withFileTypes: true})) {
      if (entry.parentPath.startsWith(join(cwd, "build"))) continue
      utimesSync(join(entry.parentPath, entry.name), at, at)
    }
  }

  test("whenever it is packed: neither the files' times nor the clock reach the ZIP", async () => {
    const cwd = project()
    touchAll(cwd, new Date("2021-03-04T05:06:07Z"))
    setSystemTime(new Date("2021-03-04T06:00:00Z"))
    const first = await pack({cwd, silent: true})
    const firstBytes = readFileSync(first)

    touchAll(cwd, new Date("2026-11-26T12:00:00Z"))
    setSystemTime(new Date("2026-11-26T13:00:00Z"))
    const second = await pack({cwd, silent: true})

    expect(second).toBe(first)
    expect(sha256(readFileSync(second))).toBe(sha256(firstBytes))
    expect(readdirSync(join(cwd, "build")).filter((name) => name.endsWith(".zip"))).toHaveLength(1)
  })

  test("wherever it is packed: two copies of a project, made at different times, pack to the same bytes", async () => {
    const one = project()
    touchAll(one, new Date("2020-01-01T00:00:00Z"))
    const other = project()
    touchAll(other, new Date("2025-06-15T18:30:00Z"))

    const a = readFileSync(await pack({cwd: one, silent: true}))
    const b = readFileSync(await pack({cwd: other, silent: true}))

    expect(sha256(b)).toBe(sha256(a))
    expect(readFileSync(join(other, "build", "miniapp.json"), "utf-8")).toBe(
      readFileSync(join(one, "build", "miniapp.json"), "utf-8"),
    )
  })

  test("every entry carries one date and its files are in name order", async () => {
    const cwd = project()
    const zip = await JSZip.loadAsync(readFileSync(await pack({cwd, silent: true})))
    const entries = Object.values(zip.files)
    expect(new Set(entries.map((entry) => entry.date.toISOString()))).toEqual(new Set(["1980-01-01T00:00:00.000Z"]))
    const files = entries.filter((entry) => !entry.dir).map((entry) => entry.name)
    expect(files).toEqual([...files].sort())
    expect(new Set(entries.filter((entry) => !entry.dir).map((entry) => entry.unixPermissions))).toEqual(
      new Set([0o100644]),
    )
  })

  test("signed with the same key too, and the signed ZIP verifies", async () => {
    const cwd = project()
    const signingKey = generatePackageSigningKey("com.example.pack")
    touchAll(cwd, new Date("2021-03-04T05:06:07Z"))
    setSystemTime(new Date("2021-03-04T06:00:00Z"))
    const first = await pack({cwd, silent: true, signingKey})
    const firstBytes = readFileSync(first)
    // The signature's own entry and folder are dated too.
    touchAll(cwd, new Date("2026-11-26T12:00:00Z"))
    setSystemTime(new Date("2026-11-26T13:00:00Z"))
    const second = await pack({cwd, silent: true, signingKey})

    expect(second).toBe(first)
    expect(sha256(readFileSync(second))).toBe(sha256(firstBytes))
    const verified = await verifySignedBundleArchive(new Uint8Array(readFileSync(second)))
    expect(verified.packageName).toBe("com.example.pack")
    expect(verified.version).toBe("1.0.0")
  })

  test("another key signs another ZIP", async () => {
    const cwd = project()
    const first = await pack({cwd, silent: true, signingKey: generatePackageSigningKey("com.example.pack")})
    const second = await pack({cwd, silent: true, signingKey: generatePackageSigningKey("com.example.pack")})
    expect(second).not.toBe(first)
  })
})

describe("the folder pack writes", () => {
  test("holds the ZIP, its icon, and miniapp.json naming the ZIP and its hash", async () => {
    const manifest = scaffoldedManifest("com.example.notes", "1.4.2")
    const cwd = createProject(manifest)
    const zipPath = await pack({cwd, silent: true})
    const build = join(cwd, "build")

    // The ZIP's name carries the first 8 hex digits of its SHA-256.
    const zipBytes = readFileSync(zipPath)
    const zipName = `com.example.notes-1.4.2-${sha256(zipBytes).slice(0, 8)}.zip`
    expect(zipPath).toBe(join(build, zipName))
    expect(readdirSync(build).sort()).toEqual([".gitignore", zipName, "icon.png", "miniapp.json"])

    const text = readFileSync(join(build, "miniapp.json"), "utf-8")
    const served = JSON.parse(text)
    expect(served).toEqual({
      ...manifest,
      bundle: {url: zipName, sha256: sha256(zipBytes)},
      versions: [{version: "1.4.2", url: zipName, sha256: sha256(zipBytes)}],
    })
    expect(text).toBe(`${JSON.stringify(served, null, 2)}\n`)
    expectServedManifest(served)

    // The ZIP's own miniapp.json is the served one without `bundle` and `versions`.
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
      `com.mentra.packcheck/${zipPath.slice(build.length + 1)}`,
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
      await pack({cwd, silent: false})
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
    for (const icon of ["./miniapp.json", "MINIAPP.JSON", "./.gitignore"]) {
      const cwd = createProject({...scaffoldedManifest("com.example.pack", "1.0.0"), icon})
      const zipPath = await pack({cwd, silent: true})
      const build = join(cwd, "build")
      expect(JSON.parse(readFileSync(join(build, "miniapp.json"), "utf-8")).icon).toBe(icon)
      expect(existsSync(join(build, ".gitignore"))).toBe(true)
      expect(existsSync(zipPath)).toBe(true)
    }
    // Nor an earlier build's ZIP, which a host may still serve.
    const cwd = createProject(scaffoldedManifest("com.example.pack", "1.0.0"))
    const earlier = await pack({cwd, silent: true})
    const icon = `./${earlier.slice(join(cwd, "build").length + 1)}`
    writeFileSync(join(cwd, "miniapp.json"), JSON.stringify({...scaffoldedManifest("com.example.pack", "1.0.0"), icon}))
    const zipPath = await pack({cwd, silent: true})
    expect(zipPath).not.toBe(earlier)
    expect(existsSync(earlier)).toBe(true)
    expect(existsSync(zipPath)).toBe(true)
  })

  test("leaves an icon on another host to that host", async () => {
    const cwd = createProject({...scaffoldedManifest("com.example.pack", "1.0.0"), icon: "https://cdn.example.com/i.png"})
    const zipPath = await pack({cwd, silent: true})
    const build = join(cwd, "build")
    expect(readdirSync(build).sort()).toEqual([".gitignore", zipPath.slice(build.length + 1), "miniapp.json"])
  })

  test("keeps older ZIPs, and miniapp.json names the newest", async () => {
    const cwd = createProject(scaffoldedManifest("com.example.pack", "1.0.0"))
    const older = await pack({cwd, silent: true})
    writeFileSync(join(cwd, "miniapp.json"), JSON.stringify(scaffoldedManifest("com.example.pack", "1.0.1")))
    const zipPath = await pack({cwd, silent: true})

    const build = join(cwd, "build")
    expect(existsSync(older)).toBe(true)
    const served = JSON.parse(readFileSync(join(build, "miniapp.json"), "utf-8"))
    expect(served.version).toBe("1.0.1")
    const hash = sha256(readFileSync(zipPath))
    expect(served.bundle).toEqual({url: `com.example.pack-1.0.1-${hash.slice(0, 8)}.zip`, sha256: hash})
  })

  test("a change with no version bump packs to another ZIP beside the earlier build's, which stays as it was", async () => {
    const cwd = createProject(scaffoldedManifest("com.example.pack", "1.0.0"))
    const first = await pack({cwd, silent: true})
    const firstBytes = readFileSync(first)

    writeFileSync(join(cwd, "dist", "index.js"), "export const changed = true")
    const second = await pack({cwd, silent: true})

    expect(second).not.toBe(first)
    expect(readFileSync(first)).toEqual(firstBytes)
    const build = join(cwd, "build")
    expect(
      readdirSync(build)
        .filter((name) => name.endsWith(".zip"))
        .sort(),
    ).toEqual([first, second].map((path) => path.slice(build.length + 1)).sort())
    // The folder's miniapp.json says which of the two is the build.
    expect(packedZipPath(build, "com.example.pack", "1.0.0")).toBe(second)
    expect(packedZipPath(build, "com.example.pack", "1.0.1")).toBeNull()
    expect(packedZipPath(build, "com.example.other", "1.0.0")).toBeNull()
    expect(packedZipPath(join(cwd, "nowhere"), "com.example.pack", "1.0.0")).toBeNull()
  })

  test("names the signed ZIP's hash for a signed pack", async () => {
    const cwd = createProject(scaffoldedManifest("com.example.pack", "1.0.0"))
    const signingKey = generatePackageSigningKey("com.example.pack")
    const zipPath = await pack({cwd, silent: true, sign: true, signingKey})

    const zipBytes = readFileSync(zipPath)
    const verified = await verifySignedBundleArchive(new Uint8Array(zipBytes))
    expect(verified.packageName).toBe("com.example.pack")
    const served = JSON.parse(readFileSync(join(cwd, "build", "miniapp.json"), "utf-8"))
    const hash = sha256(zipBytes)
    expect(served.bundle).toEqual({url: `com.example.pack-1.0.0-${hash.slice(0, 8)}.zip`, sha256: hash})
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
      await pack({cwd, silent: false})
      expect(log.mock.calls.flat()).toContain("Upload the build folder to your miniapp's URL.")
    } finally {
      log.mockRestore()
    }
  })
})

describe("versions: the versions a phone can be pinned to", () => {
  const PACKAGE = "com.example.pack"

  /** Pack the project as `version`, with `source` as its code. */
  async function packVersion(cwd: string, version: string, source = `export const version = "${version}"`, url?: string) {
    writeFileSync(join(cwd, "miniapp.json"), JSON.stringify(scaffoldedManifest(PACKAGE, version)))
    writeFileSync(join(cwd, "dist", "index.js"), source)
    const zipPath = await pack({cwd, silent: true, url})
    const hash = sha256(readFileSync(zipPath))
    return {version, url: `${PACKAGE}-${version}-${hash.slice(0, 8)}.zip`, sha256: hash}
  }

  const served = (cwd: string) => JSON.parse(readFileSync(join(cwd, "build", "miniapp.json"), "utf-8"))

  /** A host serving `miniapp.json` as `answer` gives it; returns the miniapp URL. */
  function host(answer: () => Response): string {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => (new URL(req.url).pathname === "/notes/miniapp.json" ? answer() : new Response("", {status: 404})),
    })
    servers.push(server)
    return `http://127.0.0.1:${server.port}/notes/`
  }
  const servers: Array<{stop(force?: boolean): unknown}> = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true)
  })

  const published = (version: string) => ({version, url: `${PACKAGE}-${version}-0a1b2c3d.zip`, sha256: "a".repeat(64)})

  test("the first pack lists the version it packed", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    const entry = await packVersion(cwd, "1.0.0")
    expect(served(cwd).versions).toEqual([entry])
    // An entry's url is relative to the miniapp URL, as bundle.url is.
    expect(served(cwd).bundle).toEqual({url: entry.url, sha256: entry.sha256})
  })

  test("each pack adds its version and keeps the earlier ones, highest version first", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.2.0"))
    const first = await packVersion(cwd, "1.2.0")
    const second = await packVersion(cwd, "1.10.0")
    const third = await packVersion(cwd, "1.9.3")
    expect(served(cwd).versions).toEqual([second, third, first])
    // `bundle` is the build packed last, whatever its version.
    expect(served(cwd).bundle).toEqual({url: third.url, sha256: third.sha256})
    expectServedManifest(served(cwd))
  })

  test("other bytes under a listed version replace its entry; the earlier build's ZIP stays", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    const first = await packVersion(cwd, "1.0.0")
    const other = await packVersion(cwd, "1.1.0")
    const rebuilt = await packVersion(cwd, "1.0.0", "export const rebuilt = true")
    expect(rebuilt.sha256).not.toBe(first.sha256)
    expect(served(cwd).versions).toEqual([other, rebuilt])
    expect(existsSync(join(cwd, "build", first.url))).toBe(true)
  })

  test("packing the same build again changes nothing", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    await packVersion(cwd, "1.0.0")
    await packVersion(cwd, "1.1.0")
    const before = snapshot(join(cwd, "build"))
    await packVersion(cwd, "1.1.0")
    expect(snapshot(join(cwd, "build"))).toEqual(before)
  })

  test("a prerelease sorts below its release, and above the release before it", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    for (const version of ["1.1.0", "1.0.0", "1.1.0-beta.2", "1.1.0-beta.11", "1.1.0-alpha"]) {
      await packVersion(cwd, version)
    }
    expect(served(cwd).versions.map((entry: {version: string}) => entry.version)).toEqual([
      "1.1.0",
      "1.1.0-beta.11",
      "1.1.0-beta.2",
      "1.1.0-alpha",
      "1.0.0",
    ])
  })

  test("refuses a miniapp.json that already declares versions", async () => {
    const cwd = createProject({...scaffoldedManifest(PACKAGE, "1.0.0"), versions: []})
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as typeof process.exit)
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(pack({cwd, silent: true})).rejects.toThrow("exit 1")
      expect(error.mock.calls.flat().join("\n")).toContain("must not declare versions")
    } finally {
      exit.mockRestore()
      error.mockRestore()
    }
    expect(existsSync(join(cwd, "build"))).toBe(false)
  })

  test("without --url, a version whose ZIP left the folder is no longer listed, and says so", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    const first = await packVersion(cwd, "1.0.0")
    const second = await packVersion(cwd, "1.1.0")
    rmSync(join(cwd, "build", first.url))

    writeFileSync(join(cwd, "miniapp.json"), JSON.stringify(scaffoldedManifest(PACKAGE, "1.2.0")))
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      await pack({cwd})
      expect(warn.mock.calls.flat().join("\n")).toContain(`${first.url} is not in`)
      expect(warn.mock.calls.flat().join("\n")).toContain("version 1.0.0 is no longer listed")
      expect(log.mock.calls.flat()).toContain("Versions: 1.2.0, 1.1.0")
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
    expect(served(cwd).versions.map((entry: {version: string}) => entry.version)).toEqual(["1.2.0", "1.1.0"])
    expect(served(cwd).versions[1]).toEqual(second)
  })

  test("without --url, a folder packed before the list existed keeps the build it names", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    const first = await packVersion(cwd, "1.0.0")
    const earlier = served(cwd)
    delete earlier.versions
    writeFileSync(join(cwd, "build", "miniapp.json"), JSON.stringify(earlier))

    const second = await packVersion(cwd, "1.0.1")
    expect(served(cwd).versions).toEqual([second, first])
  })

  test("without --url, another package's folder starts a new list", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    await packVersion(cwd, "1.0.0")
    const other = scaffoldedManifest("com.example.other", "3.0.0")
    writeFileSync(join(cwd, "miniapp.json"), JSON.stringify(other))
    await pack({cwd, silent: true})
    expect(served(cwd).versions.map((entry: {version: string}) => entry.version)).toEqual(["3.0.0"])
  })

  test("without --url, a list in the folder that can't be read stops the pack and nothing changes", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    await packVersion(cwd, "1.0.0")
    writeFileSync(join(cwd, "build", "miniapp.json"), JSON.stringify({...served(cwd), versions: [{version: "1.0.0"}]}))
    const before = snapshot(join(cwd, "build"))
    writeFileSync(join(cwd, "dist", "index.js"), "export const changed = true")
    await expect(pack({cwd, silent: true})).rejects.toThrow("versions[0] is not {version, url, sha256}")
    expect(snapshot(join(cwd, "build"))).toEqual(before)
  })

  test("--url keeps the versions the miniapp's URL serves, in a clean checkout", async () => {
    const live = {
      ...scaffoldedManifest(PACKAGE, "1.1.0"),
      bundle: {url: published("1.1.0").url, sha256: published("1.1.0").sha256},
      // An absolute URL stays as it was published.
      versions: [published("1.1.0"), {...published("1.0.0"), url: "https://cdn.example.com/old/1.0.0.zip"}],
    }
    let requests = 0
    const url = host(() => {
      requests += 1
      return Response.json(live)
    })
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.2.0"))
    const entry = await packVersion(cwd, "1.2.0", undefined, url)

    expect(requests).toBe(1)
    expect(served(cwd).versions).toEqual([entry, live.versions[0], live.versions[1]])
    // Their ZIPs are on the host, not in the folder.
    expect(readdirSync(join(cwd, "build")).sort()).toEqual([".gitignore", entry.url, "icon.png", "miniapp.json"])
    expectServedManifest(served(cwd))
  })

  test("--url reads the published list, not the folder's, and accepts the URL of miniapp.json itself", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    await packVersion(cwd, "1.0.0")
    const live = {packageName: PACKAGE, version: "2.0.0", versions: [published("2.0.0")]}
    const url = host(() => Response.json(live))
    for (const spelling of [url, url.slice(0, -1), `${url}miniapp.json`]) {
      const entry = await packVersion(cwd, "2.1.0", undefined, spelling)
      expect(served(cwd).versions).toEqual([entry, published("2.0.0")])
    }
  })

  test("--url replaces the published entry of the version it packs", async () => {
    const url = host(() =>
      Response.json({packageName: PACKAGE, version: "1.1.0", versions: [published("1.1.0"), published("1.0.0")]}),
    )
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    const entry = await packVersion(cwd, "1.0.0", undefined, url)
    expect(served(cwd).versions).toEqual([published("1.1.0"), entry])
  })

  test("--url: a miniapp.json published before the list existed keeps the build it serves", async () => {
    const url = host(() =>
      Response.json({
        ...scaffoldedManifest(PACKAGE, "1.0.0"),
        bundle: {url: "com.example.pack-1.0.0.zip", sha256: "B".repeat(64)},
      }),
    )
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.1"))
    const entry = await packVersion(cwd, "1.0.1", undefined, url)
    expect(served(cwd).versions).toEqual([
      entry,
      {version: "1.0.0", url: "com.example.pack-1.0.0.zip", sha256: "b".repeat(64)},
    ])
  })

  test("--url: nothing published there yet starts a new list, and says so", async () => {
    const url = host(() => new Response("not found", {status: 404}))
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      await pack({cwd, url})
      expect(log.mock.calls.flat().join("\n")).toContain(
        `Nothing is published at ${url}miniapp.json yet: starting a new versions list.`,
      )
    } finally {
      log.mockRestore()
    }
    expect(served(cwd).versions.map((entry: {version: string}) => entry.version)).toEqual(["1.0.0"])
  })

  test.each([
    ["a host that answers with an error", () => new Response("down", {status: 503}), "answered 503"],
    ["an answer that isn't JSON", () => new Response("<!doctype html>"), "is not JSON"],
    ["an answer that isn't a miniapp.json", () => Response.json([]), "is not a miniapp.json"],
    [
      "another package's miniapp.json",
      () => Response.json({packageName: "com.example.other", version: "1.0.0", versions: []}),
      "is com.example.other's miniapp.json, not com.example.pack's",
    ],
    [
      "a list that can't be read",
      () => Response.json({packageName: PACKAGE, version: "1.0.0", versions: [{version: "1.0", url: "a.zip"}]}),
      "versions[0] is not {version, url, sha256}",
    ],
    ["a list that isn't one", () => Response.json({packageName: PACKAGE, versions: {}}), "versions is not a list"],
  ])("--url: %s stops the pack, which writes nothing", async (_name, answer, message) => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    await expect(pack({cwd, silent: true, url: host(answer)})).rejects.toThrow(message)
    expect(existsSync(join(cwd, "build"))).toBe(false)
  })

  test("--url: a host that can't be reached stops the pack, which leaves the folder as it was", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    await packVersion(cwd, "1.0.0")
    const before = snapshot(join(cwd, "build"))
    // A port nothing listens on: the host was just stopped.
    const url = host(() => Response.json({}))
    for (const server of servers.splice(0)) server.stop(true)

    writeFileSync(join(cwd, "dist", "index.js"), "export const changed = true")
    await expect(pack({cwd, silent: true, url})).rejects.toThrow("Could not reach")
    await expect(pack({cwd, silent: true, url: "ftp://example.com/notes/"})).rejects.toThrow("http or https")
    await expect(pack({cwd, silent: true, url: "notes"})).rejects.toThrow("--url is not a URL")
    expect(snapshot(join(cwd, "build"))).toEqual(before)
  })

  test("keeps the 50 highest versions, and always the one it packs", async () => {
    const sixty = Array.from({length: 60}, (_, index) => published(`1.${index}.0`))
    let live: Record<string, unknown> = {packageName: PACKAGE, version: "1.59.0", versions: sixty}
    const url = host(() => Response.json(live))
    const cwd = createProject(scaffoldedManifest(PACKAGE, "2.0.0"))
    await packVersion(cwd, "2.0.0", undefined, url)
    let versions = served(cwd).versions.map((entry: {version: string}) => entry.version)
    expect(versions).toHaveLength(50)
    expect(versions.slice(0, 2)).toEqual(["2.0.0", "1.59.0"])
    expect(versions[49]).toBe("1.11.0")

    // A rollback to a version below all 50: it is the build served, so it is listed.
    live = served(cwd)
    await packVersion(cwd, "0.9.0", undefined, url)
    versions = served(cwd).versions.map((entry: {version: string}) => entry.version)
    expect(versions).toHaveLength(50)
    expect(versions[0]).toBe("2.0.0")
    expect(versions.slice(48)).toEqual(["1.12.0", "0.9.0"])
  })

  test("a version that isn't a semantic version is packed, and not listed", async () => {
    const cwd = createProject(scaffoldedManifest(PACKAGE, "1.0.0"))
    const first = await packVersion(cwd, "1.0.0")
    writeFileSync(join(cwd, "miniapp.json"), JSON.stringify(scaffoldedManifest(PACKAGE, "2024.1")))
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      await pack({cwd})
      expect(warn.mock.calls.flat().join("\n")).toContain('version "2024.1" is not a semantic version')
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
    expect(served(cwd).version).toBe("2024.1")
    expect(served(cwd).versions).toEqual([first])
  })

  test("refuses to write a miniapp.json the Mentra App is too large to read", async () => {
    const long = (version: string) => ({...published(version), url: `https://cdn.example.com/${"a".repeat(1400)}.zip`})
    const url = host(() =>
      Response.json({
        packageName: PACKAGE,
        version: "1.48.0",
        versions: Array.from({length: 49}, (_, index) => long(`1.${index}.0`)),
      }),
    )
    const cwd = createProject(scaffoldedManifest(PACKAGE, "2.0.0"))
    await expect(pack({cwd, silent: true, url})).rejects.toThrow("The Mentra App reads at most 65536")
    expect(existsSync(join(cwd, "build"))).toBe(false)
  })

  test("the first-party publisher keeps the same list, entry for entry", async () => {
    const cwd = createProject(scaffoldedManifest("com.mentra.packcheck", "1.0.0"))
    const store = memoryStore()
    const steps: Array<[string, string]> = [
      ["1.2.0", "a"],
      ["1.10.0", "b"],
      ["1.9.3", "c"],
      ["1.2.0", "rebuilt"],
      ["0.9.0", "d"],
      ["1.10.0", "b"],
    ]
    for (const [version, source] of steps) {
      writeFileSync(join(cwd, "miniapp.json"), JSON.stringify(scaffoldedManifest("com.mentra.packcheck", version)))
      writeFileSync(join(cwd, "dist", "index.js"), `export const source = "${source}"`)
      const zipPath = await pack({cwd, silent: true})
      await publishMiniapp(readArchive(zipPath), store.store)
      expect(Buffer.from(store.objects.get("com.mentra.packcheck/miniapp.json")!)).toEqual(
        readFileSync(join(cwd, "build", "miniapp.json")),
      )
    }
    expect(served(cwd).versions.map((entry: {version: string}) => entry.version)).toEqual([
      "1.10.0",
      "1.9.3",
      "1.2.0",
      "0.9.0",
    ])
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
  const bundle = parsed.data!.bundle
  expect(bundle.url).toBe(packedZipName(String(served.packageName), String(served.version), bundle.sha256))
  expect(bundle.url).toMatch(/-[0-9a-f]{8}\.zip$/)
}
