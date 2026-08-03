#!/usr/bin/env bun
/**
 * Prepare an external miniapp for bundling into mobile/assets/miniapps/.
 *
 * Never runs git. Stages version bump + zip + codegen only.
 *
 *   bun scripts/sync-miniapp.mjs <name|--repo path> [--bump patch|minor|major] [--no-bump] [--dry-run]
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import {dirname, join, resolve} from "path"
import {fileURLToPath} from "url"
import {spawnSync} from "child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..")
const MOBILE_ROOT = join(REPO_ROOT, "mobile")
const ASSETS_DIR = join(MOBILE_ROOT, "assets", "miniapps")
const REPOS_CONFIG_PATH = join(__dirname, "miniapp-repos.json")

/** Optional override for tests — point assets + generator at a fixture. */
export function createSyncContext(overrides = {}) {
  return {
    repoRoot: overrides.repoRoot ?? REPO_ROOT,
    mobileRoot: overrides.mobileRoot ?? MOBILE_ROOT,
    assetsDir: overrides.assetsDir ?? ASSETS_DIR,
    reposConfigPath: overrides.reposConfigPath ?? REPOS_CONFIG_PATH,
  }
}

function die(msg) {
  const err = new Error(msg)
  err.name = "SyncMiniappError"
  throw err
}

function loadReposConfig(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    die(`could not parse ${path}: ${err.message}`)
  }
}

/**
 * Parse strict MAJOR.MINOR.PATCH only. Rejects prerelease/build suffixes.
 * @returns {[number, number, number] | null}
 */
export function parseStrictSemver(version) {
  if (typeof version !== "string") return null
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * @param {"patch"|"minor"|"major"} part
 */
export function bumpStrictSemver(version, part = "patch") {
  const parsed = parseStrictSemver(version)
  if (!parsed) {
    throw new Error(
      `version "${version}" is not strict MAJOR.MINOR.PATCH (no prerelease/build suffixes). Edit miniapp.json manually.`,
    )
  }
  let [major, minor, patch] = parsed
  if (part === "major") {
    major += 1
    minor = 0
    patch = 0
  } else if (part === "minor") {
    minor += 1
    patch = 0
  } else {
    patch += 1
  }
  return `${major}.${minor}.${patch}`
}

/** Filename-safe reverse-domain package ids only (no path separators). */
export function assertSafePackageName(packageName) {
  if (typeof packageName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(packageName)) {
    throw new Error(
      `packageName "${packageName}" is not a safe filename identifier ` +
        `(expected letters/digits/._- only, no path separators)`,
    )
  }
  if (packageName.includes("..") || packageName.includes("/") || packageName.includes("\\")) {
    throw new Error(`packageName "${packageName}" must not contain path components`)
  }
}

export function parseArgs(argv) {
  const args = {
    name: null,
    repo: null,
    bump: "patch",
    noBump: false,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--repo") {
      args.repo = argv[++i]
    } else if (a === "--bump") {
      args.bump = argv[++i]
    } else if (a === "--no-bump") {
      args.noBump = true
    } else if (a === "--dry-run") {
      args.dryRun = true
    } else if (a === "--help" || a === "-h") {
      args.help = true
    } else if (!a.startsWith("-") && !args.name && !args.repo) {
      args.name = a
    } else {
      die(`unknown argument: ${a}`)
    }
  }
  if (args.bump && !["patch", "minor", "major"].includes(args.bump)) {
    die(`--bump must be patch, minor, or major (got ${args.bump})`)
  }
  return args
}

function resolveMiniappDir(repoPath) {
  const nested = join(repoPath, "miniapp", "miniapp.json")
  const root = join(repoPath, "miniapp.json")
  if (existsSync(nested)) return join(repoPath, "miniapp")
  if (existsSync(root)) return repoPath
  die(
    `miniapp.json not found at ${nested} or ${root}. ` +
      `Pass --repo to the external miniapp checkout root.`,
  )
}

/**
 * Find nearest package.json between miniappDir and repoPath (inclusive) that defines scripts.pack.
 * @returns {{ cwd: string, packageJsonPath: string } | null}
 */
function findPackScript(miniappDir, repoPath) {
  let cur = miniappDir
  const stop = resolve(repoPath)
  while (true) {
    const pkgPath = join(cur, "package.json")
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
        if (pkg.scripts && typeof pkg.scripts.pack === "string") {
          return {cwd: cur, packageJsonPath: pkgPath}
        }
      } catch {
        // keep walking
      }
    }
    if (resolve(cur) === stop) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  // Also check stop once more if we walked past via resolve equality edge cases
  const rootPkg = join(repoPath, "package.json")
  if (existsSync(rootPkg)) {
    try {
      const pkg = JSON.parse(readFileSync(rootPkg, "utf8"))
      if (pkg.scripts && typeof pkg.scripts.pack === "string") {
        return {cwd: repoPath, packageJsonPath: rootPkg}
      }
    } catch {
      // fallthrough
    }
  }
  return null
}

function findMentraMiniappBin(repoPath) {
  const candidates = [
    join(repoPath, "node_modules", ".bin", "mentra-miniapp"),
    join(repoPath, "miniapp", "node_modules", ".bin", "mentra-miniapp"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

function writeManifestVersion(manifestPath, manifest, version) {
  const next = {...manifest, version}
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
}

function verifyZip(zipPath, expectedPackageName, expectedVersion) {
  // Write extracted JSON to a temp file rather than relying on spawn stdout.
  // Bun's test runner can return empty stdout for nested spawnSync while status is 0.
  const outPath = `${zipPath}.verify-${process.pid}.json`
  const py = `
import json, sys, zipfile
path, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(path) as z:
    names = z.namelist()
    match = next((n for n in names if n == "miniapp.json" or n.endswith("/miniapp.json")), None)
    if match is None:
        raise SystemExit("no miniapp.json in zip; names=" + ",".join(names))
    data = json.loads(z.read(match).decode("utf-8"))
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f)
`
  const result = spawnSync("python3", ["-c", py, zipPath, outPath], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  })
  if (result.status !== 0) {
    try {
      unlinkSync(outPath)
    } catch {
      // ignore
    }
    throw new Error(`could not verify zip: ${(result.stderr || result.stdout || "").trim()}`)
  }
  let embedded
  try {
    embedded = JSON.parse(readFileSync(outPath, "utf8"))
  } catch (err) {
    throw new Error(`embedded miniapp.json is not valid JSON: ${err.message}`)
  } finally {
    try {
      unlinkSync(outPath)
    } catch {
      // ignore
    }
  }
  if (embedded.packageName !== expectedPackageName) {
    throw new Error(
      `zip packageName mismatch: expected ${expectedPackageName}, got ${embedded.packageName}`,
    )
  }
  if (embedded.version !== expectedVersion) {
    throw new Error(`zip version mismatch: expected ${expectedVersion}, got ${embedded.version}`)
  }
}

function pruneOtherZips(assetsDir, packageName, keepFileName) {
  if (!existsSync(assetsDir)) return []
  const removed = []
  for (const name of readdirSync(assetsDir)) {
    if (!name.toLowerCase().endsWith(".zip")) continue
    if (name === keepFileName) continue
    if (name.startsWith(`${packageName}-`)) {
      unlinkSync(join(assetsDir, name))
      removed.push(name)
    }
  }
  return removed
}

function generateBundled(mobileRoot) {
  const script = join(mobileRoot, "scripts", "generate-bundled-miniapps.mjs")
  if (!existsSync(script)) {
    // Test fixtures may skip full mobile layout.
    return
  }
  const result = spawnSync("bun", ["run", script], {
    cwd: mobileRoot,
    stdio: "inherit",
  })
  if (result.status !== 0) {
    die("generate-bundled-miniapps failed")
  }
}

function restoreManifestVersion(manifestPath, manifest, originalVersion) {
  writeManifestVersion(manifestPath, {...manifest, version: originalVersion}, originalVersion)
}

/**
 * Main entry used by CLI and tests.
 * @returns {{ code: number, summary?: object, error?: string }}
 */
export function syncMiniapp(rawArgs, ctx = createSyncContext()) {
  try {
    return syncMiniappInner(rawArgs, ctx)
  } catch (err) {
    if (err?.name === "SyncMiniappError") {
      console.error(`Error: ${err.message}`)
      return {code: 1, error: err.message}
    }
    throw err
  }
}

function syncMiniappInner(rawArgs, ctx) {
  const args = parseArgs(rawArgs)
  if (args.help) {
    console.log(`Usage: bun scripts/sync-miniapp.mjs <name|--repo path> [options]

Options:
  --bump patch|minor|major   Semver part to bump (default: patch)
  --no-bump                  Keep the current miniapp.json version
  --dry-run                  Print plan only; write nothing
  --repo <path>              External miniapp repo root (skips name map)

Named repos live in scripts/miniapp-repos.json (paths relative to MentraOS root).

Never commits or pushes. Prepares local changes only.`)
    return {code: 0}
  }

  if (!args.name && !args.repo) {
    die("pass a miniapp name from miniapp-repos.json or --repo <path>")
  }

  const config = loadReposConfig(ctx.reposConfigPath)
  let repoPath
  let configEntry = null
  if (args.repo) {
    repoPath = resolve(args.repo)
  } else {
    configEntry = config[args.name]
    if (!configEntry) {
      die(
        `unknown miniapp name "${args.name}". Known: ${Object.keys(config).join(", ") || "(none)"}. Or use --repo.`,
      )
    }
    repoPath = resolve(ctx.repoRoot, configEntry.repo)
  }

  if (!existsSync(repoPath)) {
    die(`repo path does not exist: ${repoPath}`)
  }

  const miniappDir = resolveMiniappDir(repoPath)
  const manifestPath = join(miniappDir, "miniapp.json")
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (err) {
    die(`could not parse ${manifestPath}: ${err.message}`)
  }
  const packageName = manifest.packageName
  if (typeof packageName !== "string" || !packageName) {
    die("miniapp.json is missing packageName")
  }
  try {
    assertSafePackageName(packageName)
  } catch (err) {
    die(err.message)
  }
  if (configEntry?.packageName && configEntry.packageName !== packageName) {
    die(
      `config packageName "${configEntry.packageName}" does not match manifest "${packageName}"`,
    )
  }

  const originalVersion = manifest.version
  if (typeof originalVersion !== "string" || !originalVersion) {
    die("miniapp.json is missing version")
  }

  let newVersion = originalVersion
  if (!args.noBump) {
    try {
      newVersion = bumpStrictSemver(originalVersion, args.bump)
    } catch (err) {
      die(err.message)
    }
  }

  const packInfo = findPackScript(miniappDir, repoPath)
  const mentraBin = findMentraMiniappBin(repoPath)
  let packCommand
  let packCwd
  if (packInfo) {
    packCommand = "bun run pack"
    packCwd = packInfo.cwd
  } else if (mentraBin) {
    packCommand = `"${mentraBin}" pack`
    packCwd = miniappDir
  } else {
    die(
      `no pack script found under ${repoPath} and no node_modules/.bin/mentra-miniapp. ` +
        `Run bun install in the target repo or add a "pack" script.`,
    )
  }

  const zipName = `${packageName}-${newVersion}.zip`
  const zipPath = join(miniappDir, "build", zipName)
  const destZip = join(ctx.assetsDir, zipName)

  console.log(`Miniapp:     ${packageName}`)
  console.log(`Repo:        ${repoPath}`)
  console.log(`Miniapp dir: ${miniappDir}`)
  console.log(`Version:     ${originalVersion} → ${newVersion}${args.noBump ? " (no bump)" : ""}`)
  console.log(`Pack:        ${packCommand} (cwd ${packCwd})`)
  console.log(`Destination: ${destZip}`)

  if (args.dryRun) {
    console.log("\n[dry-run] No files written.")
    return {
      code: 0,
      summary: {
        dryRun: true,
        packageName,
        originalVersion,
        newVersion,
        zipPath,
        destZip,
        packCommand,
        packCwd,
      },
    }
  }

  // 5. Bump version in place
  if (newVersion !== originalVersion) {
    writeManifestVersion(manifestPath, manifest, newVersion)
  }

  // 6. Build+pack
  let packResult
  if (packInfo) {
    packResult = spawnSync("bun", ["run", "pack"], {
      cwd: packCwd,
      stdio: "inherit",
      env: process.env,
    })
  } else {
    packResult = spawnSync(mentraBin, ["pack"], {
      cwd: packCwd,
      stdio: "inherit",
      env: process.env,
    })
  }

  if (packResult.status !== 0) {
    // 7. Rollback version on failure
    if (newVersion !== originalVersion) {
      restoreManifestVersion(manifestPath, manifest, originalVersion)
      console.error(`Pack failed — restored miniapp.json version to ${originalVersion}`)
    } else {
      console.error("Pack failed")
    }
    return {code: 1}
  }

  let producedZip = zipPath
  if (!existsSync(producedZip)) {
    const alt = join(packCwd, "build", zipName)
    if (existsSync(alt)) {
      producedZip = alt
    } else {
      if (newVersion !== originalVersion) {
        restoreManifestVersion(manifestPath, manifest, originalVersion)
      }
      die(
        `expected zip not found at ${zipPath}. Pack exited 0 but did not produce ${zipName}. ` +
          (newVersion !== originalVersion
            ? `Restored miniapp.json version to ${originalVersion}.`
            : ""),
      )
    }
  }

  // 8. Verify zip
  try {
    verifyZip(producedZip, packageName, newVersion)
  } catch (err) {
    try {
      unlinkSync(producedZip)
    } catch {
      // ignore
    }
    if (newVersion !== originalVersion) {
      restoreManifestVersion(manifestPath, manifest, originalVersion)
    }
    die(
      `${err.message}. Deleted the bad zip` +
        (newVersion !== originalVersion
          ? ` and restored miniapp.json version to ${originalVersion}.`
          : "."),
    )
  }

  // 9. Atomic copy into assets (keep old zips until codegen succeeds)
  mkdirSync(ctx.assetsDir, {recursive: true})
  const tempName = `.${zipName}.tmp-${process.pid}`
  const tempPath = join(ctx.assetsDir, tempName)
  try {
    copyFileSync(producedZip, tempPath)
    renameSync(tempPath, destZip)
  } catch (err) {
    try {
      unlinkSync(tempPath)
    } catch {
      // ignore
    }
    if (newVersion !== originalVersion) {
      restoreManifestVersion(manifestPath, manifest, originalVersion)
    }
    die(
      `failed to install zip into assets: ${err.message}. Previous zip left intact` +
        (newVersion !== originalVersion
          ? `; restored miniapp.json version to ${originalVersion}.`
          : "."),
    )
  }

  // 10. Regenerate bundled list while old same-package zips are still present,
  // then prune. If codegen fails, leave assets as-is (new + old zips) and
  // restore the external version so a retry can re-bump cleanly.
  try {
    generateBundled(ctx.mobileRoot)
  } catch (err) {
    if (newVersion !== originalVersion) {
      restoreManifestVersion(manifestPath, manifest, originalVersion)
    }
    die(
      `${err.message}. New zip is at ${destZip} alongside previous versions` +
        (newVersion !== originalVersion
          ? `; restored miniapp.json version to ${originalVersion}. Re-run after fixing codegen.`
          : "."),
    )
  }

  const removed = pruneOtherZips(ctx.assetsDir, packageName, zipName)
  if (removed.length) {
    console.log(`Pruned:      ${removed.join(", ")}`)
  }

  // Regenerate again so the committed list matches the pruned directory.
  try {
    generateBundled(ctx.mobileRoot)
  } catch (err) {
    die(
      `${err.message} after prune. Zip ${destZip} is installed; re-run ` +
        `bun run generate-bundled-miniapps in mobile/ to refresh the list.`,
    )
  }

  console.log("\nSummary:")
  console.log(`  ${packageName} ${originalVersion} → ${newVersion}`)
  console.log(`  Zip: ${destZip}`)
  console.log(
    `\nNo commits made. Remaining manual steps: commit+push in ${repoPath}, then commit the MentraOS changes.`,
  )

  return {
    code: 0,
    summary: {
      dryRun: false,
      packageName,
      originalVersion,
      newVersion,
      destZip,
      removed,
    },
  }
}

// CLI entry
if (import.meta.main) {
  const result = syncMiniapp(process.argv.slice(2))
  process.exit(result.code ?? 0)
}
