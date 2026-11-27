/**
 * Publish a first-party miniapp to its own URL on Mentra's static host.
 *
 * Mentra hosts its miniapps the way any developer can: as plain files at
 * `https://<host>/<packageName>/`. This uploads one ZIP to an R2 bucket:
 *
 *   <packageName>/<packageName>-<version>-<hash>.zip   the ZIP, first, never overwritten;
 *                                                      <hash> is the first 8 hex of its SHA-256
 *   <packageName>/<icon>                               the icon from the ZIP
 *   <packageName>/miniapp.json                         the ZIP's miniapp.json plus
 *                                                      bundle: {url, sha256} and versions, last
 *
 * The Mentra App checks <packageName>/miniapp.json and installs the ZIP it names
 * when that ZIP's SHA-256 is not the installed build's. So a build is published
 * whenever its SHA-256 differs from the one the host serves, on every host
 * alike: a changed build under an unchanged version, and one with a lower
 * version (a rollback), are published like any other. The build the host
 * already serves is nothing to do. Running it again finishes an interrupted
 * publish: the ZIP it stored is kept, and the rest is written.
 *
 * `versions` lists the versions a phone can be pinned to, as `mentra pack`
 * writes it: one {version, url, sha256} per version, highest version first, at
 * most 50. Each publish reads the list the host serves, puts this build's entry
 * in place of one for the same version, and keeps the others; their ZIPs stay
 * on the host, since nothing here deletes or overwrites a ZIP. Publishing a
 * version again with other bytes gives its entry the new hash, so a phone
 * pinned to that version keeps the build it has. A miniapp.json published
 * before the list existed gains one, starting with the build it serves, on its
 * next publish, including a publish of that same build. The list is read and
 * then written, so two publishes of one miniapp must never run at once.
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
import {readFileSync} from "node:fs"

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
  /**
   * What happened: published; nothing, because the host already serves this build; or, for a build the host
   * already serves, only its miniapp.json written again, to list its versions.
   */
  manifest: "published" | "already-published" | "versions-listed"
}

/** One version a phone can be pinned to: its ZIP, relative to the miniapp's URL, and that ZIP's SHA-256. */
export interface VersionEntry {
  version: string
  url: string
  sha256: string
}

const FIRST_PARTY_PACKAGE = /^com\.mentra\.[a-z0-9]+(\.[a-z0-9]+)*$/
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/

/** How many hex digits of its SHA-256 a ZIP's name carries, as `mentra pack` names one. */
const ZIP_NAME_HASH_LENGTH = 8

/** How many versions a served miniapp.json lists. */
const MAX_VERSIONS = 50

/**
 * The `versions` rules below are `mentra pack`'s (sdk/miniapp-cli/src/versions.ts). This script is copied whole
 * into other repositories, so it carries its own copy; the CLI's tests hold the two to the same answers.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Two runs of digits without leading zeros, as numbers of any size. */
const compareDigits = (a: string, b: string): number => a.length - b.length || compareText(a, b)

/** Prerelease identifiers: numbers in number order, below any with a letter; those in ASCII order. */
function compareIdentifiers(a: string, b: string): number {
  const aIsNumber = /^\d+$/.test(a)
  const bIsNumber = /^\d+$/.test(b)
  if (aIsNumber && bIsNumber) return compareDigits(a, b)
  if (aIsNumber !== bIsNumber) return aIsNumber ? -1 : 1
  return compareText(a, b)
}

/**
 * SemVer precedence: above zero when `a` is the higher version. A prerelease sorts below its release. Build
 * metadata has no precedence, so two versions that differ only there are put in plain text order.
 */
export function compareVersions(a: string, b: string): number {
  const [, ...x] = SEMVER.exec(a) ?? []
  const [, ...y] = SEMVER.exec(b) ?? []
  for (let part = 0; part < 3; part++) {
    const order = compareDigits(x[part] ?? "", y[part] ?? "")
    if (order) return order
  }
  const pre = x[3]?.split(".")
  const other = y[3]?.split(".")
  if (pre && !other) return -1
  if (!pre && other) return 1
  if (pre && other) {
    for (let index = 0; index < Math.max(pre.length, other.length); index++) {
      const left = pre[index]
      const right = other[index]
      if (left === undefined) return -1
      if (right === undefined) return 1
      const order = compareIdentifiers(left, right)
      if (order) return order
    }
  }
  return compareText(a, b)
}

/**
 * The list with `entry` in it: in place of an entry for the same version, with the others kept, highest version
 * first. Past 50 the lowest are dropped, but never `entry`: the build miniapp.json serves can always be pinned.
 */
export function mergeVersions(existing: VersionEntry[], entry: VersionEntry): VersionEntry[] {
  const seen = new Set([entry.version])
  const others = existing.filter((other) => !seen.has(other.version) && seen.add(other.version))
  others.sort((a, b) => compareVersions(b.version, a.version))
  return [entry, ...others.slice(0, MAX_VERSIONS - 1)].sort((a, b) => compareVersions(b.version, a.version))
}

function entryOf(value: unknown): VersionEntry | null {
  if (typeof value !== "object" || value === null) return null
  const {version, url, sha256} = value as Record<string, unknown>
  if (typeof version !== "string" || !SEMVER.test(version)) return null
  if (typeof url !== "string" || url.trim() === "") return null
  if (typeof sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha256)) return null
  return {version, url, sha256: sha256.toLowerCase()}
}

/**
 * The versions a served miniapp.json lists. One written before the list existed offers the build it serves. Throws
 * for a list that can't be read: writing a shorter one in its place would leave phones pinned to a version that
 * is no longer listed.
 */
export function listedVersions(served: Record<string, unknown>): VersionEntry[] {
  if (!("versions" in served)) {
    const bundle = served.bundle as Record<string, unknown> | undefined
    const entry = entryOf({version: served.version, url: bundle?.url, sha256: bundle?.sha256})
    return entry ? [entry] : []
  }
  if (!Array.isArray(served.versions)) throw new Error("versions is not a list")
  return served.versions.map((value, index) => {
    const entry = entryOf(value)
    if (!entry) throw new Error(`versions[${index}] is not {version, url, sha256} with a SemVer version and a SHA-256`)
    return entry
  })
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
  if ("versions" in manifest) throw new Error("The ZIP's miniapp.json must not declare versions")
  return {manifest, packageName, version}
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export async function publishMiniapp(archive: MiniappArchive, store: ObjectStore): Promise<PublishResult> {
  const {manifest, packageName, version} = releaseOf(archive)
  const sha256 = sha256Of(archive.bytes)
  // The name carries the hash: no build ever takes the place of another's ZIP, whatever their versions.
  const zipName = `${packageName}-${version}-${sha256.slice(0, ZIP_NAME_HASH_LENGTH)}.zip`
  const zipKey = `${packageName}/${zipName}`
  const manifestKey = `${packageName}/miniapp.json`

  // miniapp.json is written last, so a build it names is completely published.
  // Only that build is skipped. Versions are not compared.
  let listed: VersionEntry[] = []
  if (await store.exists(manifestKey)) {
    const current = JSON.parse(new TextDecoder().decode(await store.read(manifestKey))) as Record<string, unknown>
    try {
      listed = listedVersions(current)
    } catch (error) {
      throw new Error(`${manifestKey}: ${(error as Error).message}. Fix the list on the host before publishing.`)
    }
    const bundle = current.bundle as {url?: unknown; sha256?: unknown} | undefined
    if (typeof bundle?.sha256 === "string" && bundle.sha256.toLowerCase() === sha256) {
      // The ZIP stays under the name the host has it by, which an earlier publisher chose.
      const url = typeof bundle.url === "string" && SAFE_RELATIVE_PATH.test(bundle.url) ? bundle.url : zipName
      const result = {packageName, version, sha256, zipKey: `${packageName}/${url}`}
      const versions = mergeVersions(listed, {version, url, sha256})
      if (JSON.stringify(versions) === JSON.stringify(current.versions)) {
        return {...result, manifest: "already-published"}
      }
      // The build is the same, so no phone updates: only the list is new. A miniapp published before the list
      // existed is listed now, not at its next change, so its current version can be pinned before that change.
      await store.write(manifestKey, `${JSON.stringify({...current, versions}, null, 2)}\n`, "application/json")
      return {...result, manifest: "versions-listed"}
    }
  }

  // A stored ZIP never changes. One already at this build's key is this build,
  // left by an interrupted publish: it stays, and the publish is finished.
  if (await store.exists(zipKey)) {
    if (sha256Of(await store.read(zipKey)) !== sha256) {
      throw new Error(`${zipKey} holds another build, which this one would replace`)
    }
  } else {
    await store.write(zipKey, archive.bytes, "application/zip")
  }
  if (typeof manifest.icon === "string" && SAFE_RELATIVE_PATH.test(manifest.icon)) {
    const icon = archive.file(manifest.icon)
    if (icon) await store.write(`${packageName}/${manifest.icon}`, icon, contentTypeFor(manifest.icon))
  }
  const versions = mergeVersions(listed, {version, url: zipName, sha256})
  const hosted = {...manifest, bundle: {url: zipName, sha256}, versions}
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
  if (where && result.manifest !== "already-published") {
    const response = await fetch(`${where}${result.packageName}/miniapp.json`, {
      headers: {"Cache-Control": "no-cache"},
      signal: AbortSignal.timeout(30_000),
    })
    const served = (await response.json()) as {
      version?: string
      bundle?: {sha256?: string}
      versions?: Array<{version?: string; sha256?: string}>
    }
    if (served.version !== result.version || served.bundle?.sha256 !== result.sha256) {
      throw new Error(
        `The public miniapp.json shows ${served.version} (${served.bundle?.sha256}), not ${result.version} (${result.sha256})`,
      )
    }
    const entry = Array.isArray(served.versions)
      ? served.versions.find((listed) => listed?.version === result.version)
      : undefined
    if (entry?.sha256 !== result.sha256) {
      throw new Error(
        `The public miniapp.json lists ${result.version} as ${entry?.sha256 ?? "nothing"}, not ${result.sha256}`,
      )
    }
  }
}

if (import.meta.main) await main()
