/**
 * A customer's own variant of a Mentra miniapp: the same prebuilt bundle under
 * the customer's package name, talking to the customer's backend.
 *
 * The pair `{packageName, backendUrl}` is stamped into the bundle's
 * `miniapp.json` (`packageName`, and `variant: {of, backendUrl}`), so the ZIP
 * carries both halves and one SHA-256 pins them together. Core mints miniapp
 * tokens with `aud` = the installed bundle's package name, and the Mentra App
 * hands the stamped backend URL to that same bundle, so the two cannot drift
 * apart. The backend reads the same pair as `PACKAGE_NAME` and its public URL.
 *
 * Stamping is deterministic: every entry except `miniapp.json` keeps its
 * original compressed bytes, and `miniapp.json` is stored uncompressed, so the
 * same source ZIP and pair always give the same bytes and digest. The Mentra
 * App refuses a changed digest for a version it already installed, so a Runtime
 * restart or image upgrade that keeps the source ZIP must not change it.
 */
import {createHash} from "node:crypto"
import {inflateRawSync} from "node:zlib"

/** The source package's `miniapp.json` packageName, mapped to the customer's pair. */
export type MiniappVariants = Record<string, MiniappVariant>

export interface MiniappVariant {
  /** The customer's package name. Defaults to the source package name. */
  packageName: string
  /** The customer's backend origin (and optional path), without a trailing slash. */
  backendUrl?: string
}

/** What the Mentra App needs to run a variant: hosts before this ignore `variant`. */
export const VARIANT_MIN_HOST_VERSION = "3.5.0"

const PACKAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/
const SIGNATURE_PATH = "META-INF/MENTRA.SIG"
const MAX_MANIFEST_BYTES = 256 * 1024

/**
 * Parse `DEPLOYMENT_MINIAPP_VARIANTS`: a JSON object keyed by the source
 * package name, each value `{packageName?, backendUrl?}`. Empty means none.
 */
export function parseMiniappVariants(raw: string | undefined): MiniappVariants {
  const text = raw?.trim()
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("DEPLOYMENT_MINIAPP_VARIANTS must be a JSON object")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DEPLOYMENT_MINIAPP_VARIANTS must be a JSON object")
  }
  const variants: MiniappVariants = {}
  const names = new Set<string>()
  for (const [source, value] of Object.entries(parsed)) {
    const variant = resolveMiniappVariant(source, value)
    if (!variant) continue
    if (names.has(variant.packageName)) {
      throw new Error(`miniapp variant package name is used twice: ${variant.packageName}`)
    }
    names.add(variant.packageName)
    variants[source] = variant
  }
  return variants
}

/**
 * Validate one pair against its source package. Returns null when the pair
 * changes nothing (both halves left at their defaults).
 */
export function resolveMiniappVariant(source: string, value: unknown): MiniappVariant | null {
  if (!PACKAGE_NAME.test(source)) throw new Error(`miniapp variant source is not a package name: ${source}`)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`miniapp variant for ${source} must be an object`)
  }
  const {packageName: rawName, backendUrl: rawUrl, ...unknown} = value as Record<string, unknown>
  const extra = Object.keys(unknown)
  if (extra.length) throw new Error(`miniapp variant for ${source} has unknown fields: ${extra.join(", ")}`)
  if (rawName !== undefined && typeof rawName !== "string") {
    throw new Error(`miniapp variant packageName for ${source} must be a string`)
  }
  if (rawUrl !== undefined && typeof rawUrl !== "string") {
    throw new Error(`miniapp variant backendUrl for ${source} must be a string`)
  }
  const packageName = rawName?.trim() || source
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(`miniapp variant packageName for ${source} is invalid: ${packageName}`)
  }
  const backendUrl = rawUrl?.trim() ? normalizeBackendUrl(source, rawUrl) : undefined
  if (packageName === source && !backendUrl) return null
  // Mentra's backends accept only tokens for Mentra's package names, so a
  // renamed bundle left on the compiled backend could never sign in.
  if (packageName !== source && !backendUrl) {
    throw new Error(`miniapp variant ${packageName} of ${source} needs its backendUrl`)
  }
  return {packageName, ...(backendUrl ? {backendUrl} : {})}
}

function normalizeBackendUrl(source: string, raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(`miniapp variant backendUrl for ${source} is not a URL`)
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `miniapp variant backendUrl for ${source} must be an https URL without credentials, query or fragment`,
    )
  }
  return url.toString().replace(/\/+$/, "")
}

export interface StampedMiniapp {
  bytes: Uint8Array
  packageName: string
  version: string
  sha256: string
}

/**
 * Stamp `variant` into a source bundle. The source must be an unstamped
 * bundle of `source`; its publisher signature, which covers `miniapp.json`, is
 * dropped, so the variant installs unsigned under its own package name.
 */
export function stampMiniappVariant(zip: Uint8Array, source: string, variant: MiniappVariant): StampedMiniapp {
  let version = ""
  const bytes = rewriteMiniappManifest(zip, (manifest) => {
    if (manifest.packageName !== source) {
      throw new Error(`bundle is ${String(manifest.packageName)}, not ${source}`)
    }
    if (manifest.variant !== undefined) throw new Error(`bundle ${source} is already a variant`)
    // Only a build that reads its backend from the host and never falls back to
    // its compiled backend under another name can run as a variant; any other
    // build would keep calling Mentra's backend.
    if (manifest.acceptsVariant !== true) {
      throw new Error(
        `bundle ${source}@${String(
          manifest.version,
        )} does not accept a variant (no "acceptsVariant": true in its miniapp.json)`,
      )
    }
    version = typeof manifest.version === "string" ? manifest.version : ""
    if (!version) throw new Error(`bundle ${source} has no version`)
    const minHostVersion =
      typeof manifest.minHostVersion === "string" &&
      compareVersions(manifest.minHostVersion, VARIANT_MIN_HOST_VERSION) > 0
        ? manifest.minHostVersion
        : VARIANT_MIN_HOST_VERSION
    return {
      ...manifest,
      packageName: variant.packageName,
      minHostVersion,
      variant: {of: source, ...(variant.backendUrl ? {backendUrl: variant.backendUrl} : {})},
    }
  })
  return {bytes, packageName: variant.packageName, version, sha256: createHash("sha256").update(bytes).digest("hex")}
}

/**
 * Rewrite a bundle's `miniapp.json`, keeping every other entry's compressed
 * bytes and dropping the publisher signature, which covers `miniapp.json`.
 */
export function rewriteMiniappManifest(
  zip: Uint8Array,
  rewrite: (manifest: Record<string, unknown>) => Record<string, unknown>,
): Uint8Array {
  const entries = readCentralDirectory(zip)
  const manifestEntry = entries.find((entry) => entry.name === "miniapp.json")
  if (!manifestEntry) throw new Error("bundle has no root miniapp.json")
  const manifest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(entryData(zip, manifestEntry))) as Record<
    string,
    unknown
  >
  const manifestBytes = new TextEncoder().encode(JSON.stringify(rewrite(manifest), null, 2) + "\n")
  return writeZip(
    entries
      .filter((entry) => entry.name !== SIGNATURE_PATH)
      .map((entry) =>
        entry.name === "miniapp.json"
          ? {
              ...entry,
              method: 0,
              flags: entry.flags & 0x0800,
              crc32: crc32(manifestBytes),
              data: manifestBytes,
              size: manifestBytes.length,
            }
          : {...entry, data: zip.subarray(entry.dataOffset(zip), entry.dataOffset(zip) + entry.compressedSize)},
      ),
  )
}

/** Numeric `MAJOR.MINOR.PATCH` comparison; a prerelease sorts as its release. */
function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    value
      .split(/[-+]/)[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

// ── Minimal ZIP reading and writing ──────────────────────────────────────────

interface ZipEntry {
  name: string
  nameBytes: Uint8Array
  versionMadeBy: number
  versionNeeded: number
  flags: number
  method: number
  time: number
  date: number
  crc32: number
  compressedSize: number
  size: number
  internalAttributes: number
  externalAttributes: number
  localHeaderOffset: number
  dataOffset(zip: Uint8Array): number
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readCentralDirectory(zip: Uint8Array): ZipEntry[] {
  const data = view(zip)
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (data.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("bundle is not a ZIP archive")
  const count = data.getUint16(eocd + 10, true)
  const size = data.getUint32(eocd + 12, true)
  const offset = data.getUint32(eocd + 16, true)
  if (data.getUint16(eocd + 4, true) !== 0 || data.getUint16(eocd + 8, true) !== count) {
    throw new Error("multi-disk ZIP archives are not supported")
  }
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size > eocd) {
    throw new Error("ZIP64 archives are not supported")
  }
  const entries: ZipEntry[] = []
  let position = offset
  for (let i = 0; i < count; i++) {
    if (data.getUint32(position, true) !== 0x02014b50) throw new Error("bundle central directory is corrupt")
    const flags = data.getUint16(position + 8, true)
    if (flags & 0x0001) throw new Error("encrypted ZIP entries are not supported")
    const nameLength = data.getUint16(position + 28, true)
    const extraLength = data.getUint16(position + 30, true)
    const commentLength = data.getUint16(position + 32, true)
    const nameBytes = zip.slice(position + 46, position + 46 + nameLength)
    const localHeaderOffset = data.getUint32(position + 42, true)
    entries.push({
      name: new TextDecoder("utf-8", {fatal: true}).decode(nameBytes),
      nameBytes,
      versionMadeBy: data.getUint16(position + 4, true),
      versionNeeded: data.getUint16(position + 6, true),
      flags,
      method: data.getUint16(position + 10, true),
      time: data.getUint16(position + 12, true),
      date: data.getUint16(position + 14, true),
      crc32: data.getUint32(position + 16, true),
      compressedSize: data.getUint32(position + 20, true),
      size: data.getUint32(position + 24, true),
      internalAttributes: data.getUint16(position + 36, true),
      externalAttributes: data.getUint32(position + 38, true),
      localHeaderOffset,
      dataOffset(archive: Uint8Array) {
        const local = view(archive)
        if (local.getUint32(localHeaderOffset, true) !== 0x04034b50) throw new Error("bundle local header is corrupt")
        const start =
          localHeaderOffset +
          30 +
          local.getUint16(localHeaderOffset + 26, true) +
          local.getUint16(localHeaderOffset + 28, true)
        if (start + this.compressedSize > archive.length) throw new Error("bundle entry exceeds the archive")
        return start
      },
    })
    position += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function entryData(zip: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.size > MAX_MANIFEST_BYTES) throw new Error(`${entry.name} is too large`)
  const start = entry.dataOffset(zip)
  const raw = zip.subarray(start, start + entry.compressedSize)
  let bytes: Uint8Array
  if (entry.method === 0) bytes = raw
  else if (entry.method === 8) bytes = new Uint8Array(inflateRawSync(raw, {maxOutputLength: MAX_MANIFEST_BYTES}))
  else throw new Error(`${entry.name} uses unsupported ZIP compression ${entry.method}`)
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc32)
    throw new Error(`${entry.name} fails its ZIP checksum`)
  return bytes
}

function writeZip(entries: Array<ZipEntry & {data: Uint8Array}>): Uint8Array {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    // Sizes and CRC live in the headers, so no entry needs a data descriptor.
    const flags = entry.flags & ~0x0008
    const local = new Uint8Array(30 + entry.nameBytes.length)
    const l = view(local)
    l.setUint32(0, 0x04034b50, true)
    l.setUint16(4, entry.versionNeeded, true)
    l.setUint16(6, flags, true)
    l.setUint16(8, entry.method, true)
    l.setUint16(10, entry.time, true)
    l.setUint16(12, entry.date, true)
    l.setUint32(14, entry.crc32, true)
    l.setUint32(18, entry.data.length, true)
    l.setUint32(22, entry.size, true)
    l.setUint16(26, entry.nameBytes.length, true)
    l.setUint16(28, 0, true)
    local.set(entry.nameBytes, 30)

    const record = new Uint8Array(46 + entry.nameBytes.length)
    const c = view(record)
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, entry.versionMadeBy, true)
    c.setUint16(6, entry.versionNeeded, true)
    c.setUint16(8, flags, true)
    c.setUint16(10, entry.method, true)
    c.setUint16(12, entry.time, true)
    c.setUint16(14, entry.date, true)
    c.setUint32(16, entry.crc32, true)
    c.setUint32(20, entry.data.length, true)
    c.setUint32(24, entry.size, true)
    c.setUint16(28, entry.nameBytes.length, true)
    c.setUint16(36, entry.internalAttributes, true)
    c.setUint32(38, entry.externalAttributes, true)
    c.setUint32(42, offset, true)
    record.set(entry.nameBytes, 46)

    chunks.push(local, entry.data)
    central.push(record)
    offset += local.length + entry.data.length
  }
  const centralSize = central.reduce((total, record) => total + record.length, 0)
  const end = new Uint8Array(22)
  const e = view(end)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, entries.length, true)
  e.setUint16(10, entries.length, true)
  e.setUint32(12, centralSize, true)
  e.setUint32(16, offset, true)
  const out = new Uint8Array(offset + centralSize + end.length)
  let position = 0
  for (const chunk of [...chunks, ...central, end]) {
    out.set(chunk, position)
    position += chunk.length
  }
  return out
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ── Applying variants to a Runtime-served deployment manifest ────────────────

export interface ServedMiniappBundle {
  path: string
  body: Blob | ArrayBuffer
}

/**
 * Replace each varied managed entry, and the bundle Runtime serves for it,
 * with the stamped variant: its package name, `/miniapps/<name>-<version>.zip`
 * and digest. The source bundle has already been checked against its entry.
 */
export async function applyMiniappVariants(
  manifestText: string,
  bundles: ServedMiniappBundle[],
  variants: MiniappVariants,
): Promise<{manifest: string; bundles: ServedMiniappBundle[]}> {
  const sources = Object.keys(variants)
  if (sources.length === 0) return {manifest: manifestText, bundles}
  if (!manifestText) throw new Error("miniapp variants need a deployment manifest")
  const manifest = JSON.parse(manifestText) as {
    services?: {runtimeUrl?: string}
    miniapps?: {
      managed?: Array<{packageName: string; version: string; bundleUrl: string; sha256: string}>
      configuration?: Record<string, unknown>
    }
  }
  const managed = manifest.miniapps?.managed ?? []
  const taken = new Set(managed.map((entry) => entry.packageName))
  const served = [...bundles]
  for (const source of sources) {
    const variant = variants[source]!
    const index = managed.findIndex((entry) => entry.packageName === source)
    if (index < 0) throw new Error(`miniapp variant names ${source}, which the deployment manifest does not manage`)
    if (variant.packageName !== source && taken.has(variant.packageName)) {
      throw new Error(`miniapp variant ${variant.packageName} is already a managed package`)
    }
    if (variant.packageName !== source && manifest.miniapps?.configuration?.[source] !== undefined) {
      throw new Error(`miniapps.configuration names ${source}; key it by its variant ${variant.packageName} instead`)
    }
    const entry = managed[index]!
    const sourceUrl = new URL(entry.bundleUrl)
    const bundleIndex = served.findIndex((bundle) => bundle.path === sourceUrl.pathname)
    if (bundleIndex < 0) {
      throw new Error(`miniapp variant of ${source} needs Runtime to serve its bundle (DEPLOYMENT_MANAGED_MINIAPP_DIR)`)
    }
    const body = served[bundleIndex]!.body
    const zip = new Uint8Array(body instanceof Blob ? await body.arrayBuffer() : body)
    const stamped = stampMiniappVariant(zip, source, variant)
    if (stamped.version !== entry.version) {
      throw new Error(`miniapp ${source} bundle is ${stamped.version}, not ${entry.version}`)
    }
    const path = `/miniapps/${stamped.packageName}-${stamped.version}.zip`
    if (served.some((bundle, i) => i !== bundleIndex && bundle.path === path)) {
      throw new Error(`miniapp variant path is already served: ${path}`)
    }
    managed[index] = {
      packageName: stamped.packageName,
      version: stamped.version,
      bundleUrl: new URL(path, sourceUrl.origin).toString(),
      sha256: stamped.sha256,
    }
    taken.add(stamped.packageName)
    served[bundleIndex] = {path, body: stamped.bytes.buffer.slice(0) as ArrayBuffer}
  }
  return {manifest: JSON.stringify(manifest, null, 2) + "\n", bundles: served}
}
