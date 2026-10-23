/**
 * Publish a first-party miniapp to its own URL on Mentra's static host.
 *
 * Mentra hosts its miniapps the way any developer can: as plain files at
 * `https://<host>/<packageName>/`. This uploads one ZIP to an R2 bucket:
 *
 *   <packageName>/<packageName>-<version>.zip   the ZIP, first, never overwritten
 *   <packageName>/<icon>                          the icon from the ZIP
 *   <packageName>/miniapp.json                    the ZIP's miniapp.json plus
 *                                                 bundle: {url, sha256}, last
 *
 * The Mentra App checks <packageName>/miniapp.json and installs a newer release.
 * A version the host already has is skipped, so publishing happens when
 * miniapp.json's version is bumped; an older version never replaces a newer one.
 * Running it again finishes an interrupted publish from the stored ZIP.
 *
 * Usage: bun publish-miniapp-r2.ts <path to ZIP>
 * Environment: MINIAPPS_R2_ENDPOINT, MINIAPPS_R2_ACCESS_KEY_ID,
 * MINIAPPS_R2_SECRET_ACCESS_KEY, MINIAPPS_R2_BUCKET, and optionally
 * MINIAPPS_PUBLIC_URL to read the result back.
 *
 * The canonical copy lives in MentraOS at .github/scripts/publish-miniapp-r2.ts,
 * with its tests. First-party miniapp repositories keep an identical copy.
 */
import {S3Client} from "bun"
import {createHash} from "node:crypto"
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

export interface ObjectStore {
  exists(key: string): Promise<boolean>
  read(key: string): Promise<Uint8Array>
  write(key: string, data: Uint8Array | string, contentType: string): Promise<void>
}

export interface MiniappArchive {
  bytes: Uint8Array
  /** The ZIP's miniapp.json, as text. */
  manifest: string
  /** Reads one file from the ZIP, or null when it is absent. */
  file(path: string): Uint8Array | null
}

export interface PublishResult {
  packageName: string
  version: string
  sha256: string
  zipKey: string
  /** What happened: published, or skipped because the host has this version or a newer one. */
  manifest: "published" | "already-published" | "kept-newer"
}

const FIRST_PARTY_PACKAGE = /^com\.mentra\.[a-z0-9]+(\.[a-z0-9]+)*$/
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".png")) return "image/png"
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg"
  if (path.endsWith(".webp")) return "image/webp"
  return "application/octet-stream"
}

/** The package name and version a ZIP's miniapp.json declares, once it passes the first-party rules. */
function releaseOf(archive: MiniappArchive): {manifest: Record<string, unknown>; packageName: string; version: string} {
  const manifest = JSON.parse(archive.manifest) as Record<string, unknown>
  const packageName = manifest.packageName
  const version = manifest.version
  if (typeof packageName !== "string" || !FIRST_PARTY_PACKAGE.test(packageName)) {
    throw new Error(`Expected a first-party com.mentra package, got ${String(packageName)}`)
  }
  if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
    throw new Error(`Expected a MAJOR.MINOR.PATCH version, got ${String(version)}`)
  }
  if ("bundle" in manifest) throw new Error("The ZIP's miniapp.json must not declare a bundle")
  return {manifest, packageName, version}
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export async function publishMiniapp(
  archive: MiniappArchive,
  store: ObjectStore,
  openStored: (bytes: Uint8Array) => MiniappArchive = archiveFromBytes,
): Promise<PublishResult> {
  const {packageName, version} = releaseOf(archive)
  const zipName = `${packageName}-${version}.zip`
  const zipKey = `${packageName}/${zipName}`
  const manifestKey = `${packageName}/miniapp.json`

  // miniapp.json is written last, so a version it names is completely published.
  // A rebuild of that version is skipped: publishing happens when it is bumped.
  if (await store.exists(manifestKey)) {
    const current = JSON.parse(new TextDecoder().decode(await store.read(manifestKey))) as {
      version?: string
      bundle?: {sha256?: string}
    }
    if (typeof current.version === "string" && RELEASE_VERSION.test(current.version)) {
      const order = compareVersions(current.version, version)
      if (order > 0) return {packageName, version, sha256: sha256Of(archive.bytes), zipKey, manifest: "kept-newer"}
      if (order === 0) {
        const sha256 = current.bundle?.sha256 ?? sha256Of(archive.bytes)
        return {packageName, version, sha256, zipKey, manifest: "already-published"}
      }
    }
  }

  // A stored ZIP never changes. One left by an interrupted publish is finished
  // from its own bytes and manifest, never replaced by a rebuild.
  let release = archive
  if (await store.exists(zipKey)) {
    release = openStored(await store.read(zipKey))
    const stored = releaseOf(release)
    if (stored.packageName !== packageName || stored.version !== version) {
      throw new Error(`${zipKey} holds ${stored.packageName}@${stored.version}`)
    }
  } else {
    await store.write(zipKey, archive.bytes, "application/zip")
  }
  const {manifest} = releaseOf(release)
  const sha256 = sha256Of(release.bytes)
  if (typeof manifest.icon === "string" && SAFE_RELATIVE_PATH.test(manifest.icon)) {
    const icon = release.file(manifest.icon)
    if (icon) await store.write(`${packageName}/${manifest.icon}`, icon, contentTypeFor(manifest.icon))
  }
  const hosted = {...manifest, bundle: {url: zipName, sha256}}
  await store.write(manifestKey, `${JSON.stringify(hosted, null, 2)}\n`, "application/json")
  return {packageName, version, sha256, zipKey, manifest: "published"}
}

/** Reads a ZIP with the system `unzip`, present on macOS and GitHub's runners. */
export function readArchive(path: string): MiniappArchive {
  const bytes = new Uint8Array(readFileSync(path))
  const file = (entry: string): Uint8Array | null => {
    const result = Bun.spawnSync(["unzip", "-p", path, entry], {stdout: "pipe", stderr: "pipe"})
    return result.exitCode === 0 && result.stdout.length > 0 ? new Uint8Array(result.stdout) : null
  }
  const manifest = file("miniapp.json")
  if (!manifest) throw new Error(`${path} has no miniapp.json at its root`)
  return {bytes, manifest: new TextDecoder().decode(manifest), file}
}

/** Reads a ZIP held in memory, such as one already stored on the host. */
export function archiveFromBytes(bytes: Uint8Array): MiniappArchive {
  const directory = mkdtempSync(join(tmpdir(), "stored-miniapp-"))
  const path = join(directory, "bundle.zip")
  writeFileSync(path, bytes)
  return readArchive(path)
}

const STORAGE_TIMEOUT_MS = 60_000

/** Fail a stalled storage call instead of letting CI hang. */
function withTimeout<T>(operation: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out`)), STORAGE_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const STORAGE_ATTEMPTS = 3

/** R2 sometimes answers with a transient error; every call here is safe to repeat. */
async function withRetries<T>(operation: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(operation, call())
    } catch (error) {
      if (attempt >= STORAGE_ATTEMPTS) throw error
      console.warn(`${operation} failed (attempt ${attempt} of ${STORAGE_ATTEMPTS}): ${String(error)}`)
      await Bun.sleep(2_000 * attempt)
    }
  }
}

export function r2Store(env: Record<string, string | undefined>): ObjectStore {
  const required = [
    "MINIAPPS_R2_ENDPOINT",
    "MINIAPPS_R2_ACCESS_KEY_ID",
    "MINIAPPS_R2_SECRET_ACCESS_KEY",
    "MINIAPPS_R2_BUCKET",
  ]
  const missing = required.filter((name) => !env[name])
  if (missing.length > 0) throw new Error(`Missing ${missing.join(", ")}`)
  const client = new S3Client({
    endpoint: env.MINIAPPS_R2_ENDPOINT,
    accessKeyId: env.MINIAPPS_R2_ACCESS_KEY_ID,
    secretAccessKey: env.MINIAPPS_R2_SECRET_ACCESS_KEY,
    bucket: env.MINIAPPS_R2_BUCKET,
  })
  return {
    exists: (key) => withRetries(`Checking ${key}`, () => client.file(key).exists()),
    read: async (key) => new Uint8Array(await withRetries(`Reading ${key}`, () => client.file(key).arrayBuffer())),
    write: async (key, data, contentType) => {
      await withRetries(`Writing ${key}`, () => client.write(key, data, {type: contentType}))
    },
  }
}

async function main(): Promise<void> {
  const zipPath = process.argv[2]
  if (!zipPath) throw new Error("Usage: bun publish-miniapp-r2.ts <path to ZIP>")
  const result = await publishMiniapp(readArchive(zipPath), r2Store(process.env))
  const where = process.env.MINIAPPS_PUBLIC_URL?.replace(/\/?$/, "/")
  console.log(
    `${result.packageName}@${result.version} (${result.sha256}): miniapp.json ${result.manifest}` +
      (where ? ` at ${where}${result.packageName}/` : ""),
  )
  if (where && result.manifest === "published") {
    const response = await fetch(`${where}${result.packageName}/miniapp.json`, {
      headers: {"Cache-Control": "no-cache"},
      signal: AbortSignal.timeout(30_000),
    })
    const served = (await response.json()) as {version?: string; bundle?: {sha256?: string}}
    if (served.version !== result.version || served.bundle?.sha256 !== result.sha256) {
      throw new Error(`The public miniapp.json shows ${served.version}, not ${result.version}`)
    }
  }
}

if (import.meta.main) await main()
