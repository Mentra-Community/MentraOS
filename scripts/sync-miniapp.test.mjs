import {afterAll, describe, expect, test} from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs"
import {tmpdir} from "os"
import {join} from "path"
import {
  syncMiniapp,
  bumpStrictSemver,
  parseStrictSemver,
  assertSafePackageName,
  isSamePackageZip,
  pruneOtherZips,
} from "./sync-miniapp.mjs"

const fixtureRoots = []

function makeFixtureRoot() {
  const dir = mkdtempSync(join(tmpdir(), "sync-miniapp-test-"))
  fixtureRoots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of fixtureRoots) {
    try {
      rmSync(dir, {recursive: true, force: true})
    } catch {
      // ignore
    }
  }
})

function writeFixtureRepo(base, {version = "1.0.0", packageName = "com.mentra.test", packFails = false} = {}) {
  const repo = join(base, "TestMiniapp")
  const miniappDir = join(repo, "miniapp")
  const distDir = join(miniappDir, "dist")
  mkdirSync(distDir, {recursive: true})
  writeFileSync(
    join(miniappDir, "miniapp.json"),
    JSON.stringify(
      {
        packageName,
        version,
        name: "Test",
        hardwareRequirements: [],
      },
      null,
      2,
    ) + "\n",
  )
  writeFileSync(join(distDir, "index.js"), "console.log('ok')\n")
  // Embed miniapp.json into dist so the pack script's zip contains it.
  writeFileSync(
    join(distDir, "miniapp.json"),
    JSON.stringify({packageName, version, name: "Test", hardwareRequirements: []}, null, 2) + "\n",
  )

  if (packFails) {
    writeFileSync(join(repo, "pack.sh"), "#!/bin/sh\nexit 1\n", {mode: 0o755})
  } else {
    // Build zip with bun/node so fixtures don't depend on shell zip variable quirks.
    writeFileSync(
      join(repo, "pack.mjs"),
      `import {readFileSync, mkdirSync, copyFileSync} from "fs"
import {join} from "path"
import {spawnSync} from "child_process"
const miniappDir = join(import.meta.dir, "miniapp")
const manifest = JSON.parse(readFileSync(join(miniappDir, "miniapp.json"), "utf8"))
const dist = join(miniappDir, "dist")
copyFileSync(join(miniappDir, "miniapp.json"), join(dist, "miniapp.json"))
const buildDir = join(miniappDir, "build")
mkdirSync(buildDir, {recursive: true})
const zipPath = join(buildDir, \`\${manifest.packageName}-\${manifest.version}.zip\`)
// Zip via python so the fixture does not depend on system zip/stdout quirks.
const py = \`
import pathlib, sys, zipfile
dist, zip_path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(dist.rglob("*")):
        if path.is_file():
            zf.write(path, path.relative_to(dist).as_posix())
\`
const result = spawnSync("python3", ["-c", py, dist, zipPath], {stdio: "inherit"})
if (result.status !== 0) process.exit(result.status ?? 1)
`,
    )
    writeFileSync(
      join(repo, "pack.sh"),
      "#!/bin/sh\nset -e\nbun ./pack.mjs\n",
      {mode: 0o755},
    )
  }

  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify(
      {
        name: "test-miniapp",
        private: true,
        scripts: {pack: "sh ./pack.sh"},
      },
      null,
      2,
    ) + "\n",
  )

  return {repo, miniappDir}
}

function writeMentraLayout(base) {
  const assetsDir = join(base, "mobile", "assets", "miniapps")
  const scriptsDir = join(base, "mobile", "scripts")
  const genDir = join(base, "mobile", "src", "generated")
  mkdirSync(assetsDir, {recursive: true})
  mkdirSync(scriptsDir, {recursive: true})
  mkdirSync(genDir, {recursive: true})
  // Minimal generator that writes whatever zips exist
  writeFileSync(
    join(scriptsDir, "generate-bundled-miniapps.mjs"),
    `import {readdir, writeFile, mkdir} from "fs/promises"
import path from "path"
import {fileURLToPath} from "url"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dir = path.join(root, "assets", "miniapps")
const zips = (await readdir(dir)).filter(f => f.endsWith(".zip")).sort()
const out = path.join(root, "src", "generated", "bundledMiniapps.ts")
await mkdir(path.dirname(out), {recursive: true})
await writeFile(out, "export const BUNDLED_MINIAPPS = [\\n" + zips.map(z => "  '" + z + "',\\n").join("") + "]\\n")
console.log("generated", zips.length)
`,
  )
  writeFileSync(join(genDir, "bundledMiniapps.ts"), "export const BUNDLED_MINIAPPS = []\n")
  return {assetsDir, mobileRoot: join(base, "mobile")}
}

describe("parseStrictSemver / bumpStrictSemver", () => {
  test("accepts strict versions and bumps", () => {
    expect(parseStrictSemver("1.2.3")).toEqual([1, 2, 3])
    expect(bumpStrictSemver("1.2.3", "patch")).toBe("1.2.4")
    expect(bumpStrictSemver("1.2.3", "minor")).toBe("1.3.0")
    expect(bumpStrictSemver("1.2.3", "major")).toBe("2.0.0")
  })

  test("rejects prerelease", () => {
    expect(parseStrictSemver("1.0.0-dev.1")).toBeNull()
    expect(() => bumpStrictSemver("1.0.0-dev.1", "patch")).toThrow(/strict MAJOR.MINOR.PATCH/)
  })
})

describe("assertSafePackageName", () => {
  test("accepts reverse-domain ids", () => {
    expect(() => assertSafePackageName("com.mentra.livestreamer")).not.toThrow()
  })

  test("rejects path traversal", () => {
    expect(() => assertSafePackageName("../evil")).toThrow(/safe filename/)
    expect(() => assertSafePackageName("com/mentra")).toThrow(/safe filename/)
    // Passes the char-class regex; must still be caught by the `..` guard.
    expect(() => assertSafePackageName("evil..name")).toThrow(/path components/)
  })
})

describe("isSamePackageZip / pruneOtherZips", () => {
  test("matches only exact packageName-version.zip", () => {
    expect(isSamePackageZip("com.mentra.foo-1.0.0.zip", "com.mentra.foo")).toBe(true)
    expect(isSamePackageZip("com.mentra.foo-bar-1.0.0.zip", "com.mentra.foo")).toBe(false)
    expect(isSamePackageZip("com.mentra.foo-bar-1.0.0.zip", "com.mentra.foo-bar")).toBe(true)
  })

  test("prune does not delete hyphenated sibling packages", () => {
    const base = makeFixtureRoot()
    const assetsDir = join(base, "assets")
    mkdirSync(assetsDir, {recursive: true})
    writeFileSync(join(assetsDir, "com.mentra.foo-1.0.0.zip"), "old")
    writeFileSync(join(assetsDir, "com.mentra.foo-bar-2.0.0.zip"), "sibling")
    writeFileSync(join(assetsDir, "com.mentra.foo-1.0.1.zip"), "keep")

    const removed = pruneOtherZips(assetsDir, "com.mentra.foo", "com.mentra.foo-1.0.1.zip")
    expect(removed).toEqual(["com.mentra.foo-1.0.0.zip"])
    expect(existsSync(join(assetsDir, "com.mentra.foo-bar-2.0.0.zip"))).toBe(true)
    expect(existsSync(join(assetsDir, "com.mentra.foo-1.0.1.zip"))).toBe(true)
  })
})

describe("syncMiniapp", () => {
  test("dry-run mutates nothing", () => {
    const base = makeFixtureRoot()
    const {repo, miniappDir} = writeFixtureRepo(base, {version: "1.0.0"})
    const {assetsDir, mobileRoot} = writeMentraLayout(base)
    // Stale zip already present
    writeFileSync(join(assetsDir, "com.mentra.test-1.0.0.zip"), "old")

    const beforeManifest = readFileSync(join(miniappDir, "miniapp.json"), "utf8")
    const beforeAssets = readdirSync(assetsDir).sort().join(",")

    const result = syncMiniapp(["--repo", repo, "--dry-run"], {
      repoRoot: base,
      mobileRoot,
      assetsDir,
      reposConfigPath: join(base, "missing.json"),
    })

    expect(result.code).toBe(0)
    expect(result.summary.dryRun).toBe(true)
    expect(result.summary.newVersion).toBe("1.0.1")
    expect(readFileSync(join(miniappDir, "miniapp.json"), "utf8")).toBe(beforeManifest)
    expect(readdirSync(assetsDir).sort().join(",")).toBe(beforeAssets)
  })

  test("normal run bumps version, installs zip, prunes old, regenerates list", () => {
    const base = makeFixtureRoot()
    const {repo} = writeFixtureRepo(base, {version: "1.0.0", packageName: "com.mentra.test"})
    const {assetsDir, mobileRoot} = writeMentraLayout(base)
    writeFileSync(join(assetsDir, "com.mentra.test-1.0.0.zip"), "old-zip-bytes")
    writeFileSync(join(assetsDir, "com.mentra.other-2.0.0.zip"), "keep-me")

    const result = syncMiniapp(["--repo", repo], {
      repoRoot: base,
      mobileRoot,
      assetsDir,
      reposConfigPath: join(base, "missing.json"),
    })

    expect(result.code).toBe(0)
    expect(result.summary.newVersion).toBe("1.0.1")
    expect(existsSync(join(assetsDir, "com.mentra.test-1.0.1.zip"))).toBe(true)
    expect(existsSync(join(assetsDir, "com.mentra.test-1.0.0.zip"))).toBe(false)
    expect(existsSync(join(assetsDir, "com.mentra.other-2.0.0.zip"))).toBe(true)

    const gen = readFileSync(join(mobileRoot, "src", "generated", "bundledMiniapps.ts"), "utf8")
    expect(gen).toContain("com.mentra.test-1.0.1.zip")
    expect(gen).toContain("com.mentra.other-2.0.0.zip")

    const manifest = JSON.parse(readFileSync(join(repo, "miniapp", "miniapp.json"), "utf8"))
    expect(manifest.version).toBe("1.0.1")
  })

  test("failed pack restores miniapp.json version and leaves assets untouched", () => {
    const base = makeFixtureRoot()
    const {repo, miniappDir} = writeFixtureRepo(base, {version: "2.0.0", packFails: true})
    const {assetsDir, mobileRoot} = writeMentraLayout(base)
    writeFileSync(join(assetsDir, "com.mentra.test-2.0.0.zip"), "existing")

    const result = syncMiniapp(["--repo", repo], {
      repoRoot: base,
      mobileRoot,
      assetsDir,
      reposConfigPath: join(base, "missing.json"),
    })

    expect(result.code).toBe(1)
    const manifest = JSON.parse(readFileSync(join(miniappDir, "miniapp.json"), "utf8"))
    expect(manifest.version).toBe("2.0.0")
    expect(readdirSync(assetsDir)).toEqual(["com.mentra.test-2.0.0.zip"])
  })
})
