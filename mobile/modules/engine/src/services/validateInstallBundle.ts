import JSZip from "jszip"

const MAX_EXPANDED_BYTES = 200 * 1024 * 1024
const MAX_ENTRIES = 2_000
const MAX_MANIFEST_BYTES = 256 * 1024
const PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export async function validateInstallBundleArchive(
  bytes: Uint8Array,
  expected?: {packageName?: string; version?: string},
): Promise<{packageName: string; version: string}> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes, {checkCRC32: true})
  } catch {
    throw new Error("bundle is not a valid ZIP archive")
  }
  const entries = Object.values(zip.files)
  if (entries.length === 0 || entries.length > MAX_ENTRIES)
    throw new Error("bundle contains an invalid number of files")
  let expanded = 0
  for (const entry of entries) {
    const original = (entry as JSZip.JSZipObject & {unsafeOriginalName?: string}).unsafeOriginalName ?? entry.name
    if (!safePath(original) || !safePath(entry.name)) throw new Error(`bundle contains an unsafe path: ${original}`)
    if (isSymlink(entry)) throw new Error(`bundle contains a symbolic link: ${original}`)
    const size = (entry as JSZip.JSZipObject & {_data?: {uncompressedSize?: number}})._data?.uncompressedSize ?? 0
    expanded += Number.isFinite(size) ? Math.max(0, size) : 0
    if (expanded > MAX_EXPANDED_BYTES) throw new Error("bundle expands beyond the host limit")
  }
  const manifests = entries.filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith("miniapp.json"))
  if (manifests.length !== 1 || manifests[0]?.name !== "miniapp.json") {
    throw new Error("bundle must contain exactly one root miniapp.json")
  }
  const manifestText = await manifests[0].async("string")
  if (new TextEncoder().encode(manifestText).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("bundle manifest exceeds the host limit")
  }
  const manifest = JSON.parse(manifestText) as Record<string, unknown>
  const packageName = typeof manifest.packageName === "string" ? manifest.packageName : ""
  const version = typeof manifest.version === "string" ? manifest.version : ""
  if (!PACKAGE_NAME_PATTERN.test(packageName)) throw new Error("bundle manifest has an invalid packageName")
  if (!VERSION_PATTERN.test(version)) throw new Error("bundle manifest has an invalid semantic version")
  if (expected?.packageName && expected.packageName !== packageName) {
    throw new Error(`bundle package mismatch: expected ${expected.packageName}, got ${packageName}`)
  }
  if (expected?.version && expected.version !== version) {
    throw new Error(`bundle version mismatch: expected ${expected.version}, got ${version}`)
  }
  const manifestEntry = manifest.entry
  if (manifestEntry && typeof manifestEntry === "object" && !Array.isArray(manifestEntry)) {
    for (const key of ["background", "ui"] as const) {
      const path = (manifestEntry as Record<string, unknown>)[key]
      if (path === undefined) continue
      if (typeof path !== "string" || !safePath(path) || !zip.files[path] || zip.files[path].dir) {
        throw new Error(`bundle manifest entry.${key} is invalid or missing`)
      }
    }
  }
  return {packageName, version}
}

function safePath(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path)) return false
  return !path.split("/").some((part) => part === "..")
}

function isSymlink(entry: JSZip.JSZipObject): boolean {
  const permissions = entry.unixPermissions
  return typeof permissions === "number" && (permissions & 0o170000) === 0o120000
}
