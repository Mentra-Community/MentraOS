import JSZip from "jszip"
import semver from "semver"
import nacl from "tweetnacl"
import {Buffer} from "buffer"

import {HardwareRequirementLevel, HardwareType, type HardwareRequirement} from "../types"
import {sha256Hex} from "../utils/sha256"

const MAX_EXPANDED_BYTES = 200 * 1024 * 1024
const MAX_ENTRIES = 2_000
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_SIGNATURE_BYTES = 16 * 1024
const MENTRA_BUNDLE_SIGNATURE_PATH = "META-INF/MENTRA.SIG"
const PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const AUTHOR_DECLARABLE_PERMISSION_TYPES = new Set([
  "MICROPHONE",
  "CAMERA",
  "CALENDAR",
  "LOCATION",
  "BACKGROUND_LOCATION",
  "READ_NOTIFICATIONS",
  "POST_NOTIFICATIONS",
])

export async function validateInstallBundleArchive(
  bytes: Uint8Array,
  expected?: {packageName?: string; version?: string; requirePublisherSignature?: boolean},
): Promise<{
  packageName: string
  version: string
  sdkVersion?: string
  minHostVersion?: string
  hardwareRequirements: HardwareRequirement[]
  publisherKeyFingerprint?: string
}> {
  inspectCentralDirectory(bytes)
  let zip: JSZip
  try {
    // CRC is checked below while each entry is streamed through explicit size
    // ceilings. JSZip's checkCRC32 option inflates every entry up front and can
    // allocate attacker-controlled expanded output before we inspect sizes.
    zip = await JSZip.loadAsync(bytes, {checkCRC32: false})
  } catch {
    throw new Error("bundle is not a valid ZIP archive")
  }
  const entries = Object.values(zip.files)
  if (entries.length === 0 || entries.length > MAX_ENTRIES)
    throw new Error("bundle contains an invalid number of files")
  let declaredExpanded = 0
  for (const entry of entries) {
    const original = (entry as JSZip.JSZipObject & {unsafeOriginalName?: string}).unsafeOriginalName ?? entry.name
    if (!safePath(original) || !safePath(entry.name)) throw new Error(`bundle contains an unsafe path: ${original}`)
    if (isSymlink(entry)) throw new Error(`bundle contains a symbolic link: ${original}`)
    const size = compressedMetadata(entry).uncompressedSize
    declaredExpanded += size
    if (declaredExpanded > MAX_EXPANDED_BYTES) throw new Error("bundle expands beyond the host limit")
  }
  const manifests = entries.filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith("miniapp.json"))
  if (manifests.length !== 1 || manifests[0]?.name !== "miniapp.json") {
    throw new Error("bundle must contain exactly one root miniapp.json")
  }
  let actualExpanded = 0
  let manifestBytes: Uint8Array | undefined
  let signatureBytes: Uint8Array | undefined
  const signedFiles: Array<{path: string; size: number; sha256: string}> = []
  for (const entry of entries) {
    const remaining = MAX_EXPANDED_BYTES - actualExpanded
    const capture = !entry.dir
    const captured = await verifyEntryStream(
      entry,
      Math.min(
        remaining,
        entry.name === "miniapp.json"
          ? MAX_MANIFEST_BYTES
          : entry.name.toLowerCase() === MENTRA_BUNDLE_SIGNATURE_PATH.toLowerCase()
            ? MAX_SIGNATURE_BYTES
            : Infinity,
      ),
      capture,
    )
    actualExpanded += compressedMetadata(entry).uncompressedSize
    if (!captured || entry.dir) continue
    if (entry.name === "miniapp.json") manifestBytes = captured
    if (entry.name === MENTRA_BUNDLE_SIGNATURE_PATH) signatureBytes = captured
    if (entry.name !== MENTRA_BUNDLE_SIGNATURE_PATH) {
      signedFiles.push({path: entry.name, size: captured.byteLength, sha256: await sha256Hex(captured)})
    }
  }
  if (!manifestBytes) throw new Error("could not read bundle manifest")
  const manifestText = new TextDecoder("utf-8", {fatal: true}).decode(manifestBytes)
  const manifest = JSON.parse(manifestText) as Record<string, unknown>
  const packageName = typeof manifest.packageName === "string" ? manifest.packageName : ""
  const version = typeof manifest.version === "string" ? manifest.version : ""
  const sdkVersion = typeof manifest.sdkVersion === "string" ? manifest.sdkVersion : undefined
  const minHostVersion = typeof manifest.minHostVersion === "string" ? manifest.minHostVersion : undefined
  validateManifestPermissions(manifest.permissions)
  const hardwareRequirements = validateManifestHardwareRequirements(manifest.hardwareRequirements)
  if (!PACKAGE_NAME_PATTERN.test(packageName)) throw new Error("bundle manifest has an invalid packageName")
  if (!semver.valid(version)) throw new Error("bundle manifest has an invalid semantic version")
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
  const requirePublisherSignature = expected?.requirePublisherSignature !== false
  const publisherKeyFingerprint = signatureBytes
    ? await verifyPublisherSignature({signatureBytes, signedFiles, manifest, packageName, version})
    : undefined
  if (requirePublisherSignature && !publisherKeyFingerprint) {
    throw new Error(`bundle must contain exactly one ${MENTRA_BUNDLE_SIGNATURE_PATH}`)
  }
  return {
    packageName,
    version,
    sdkVersion,
    minHostVersion,
    hardwareRequirements,
    ...(publisherKeyFingerprint ? {publisherKeyFingerprint} : {}),
  }
}

async function verifyPublisherSignature(input: {
  signatureBytes: Uint8Array
  signedFiles: Array<{path: string; size: number; sha256: string}>
  manifest: Record<string, unknown>
  packageName: string
  version: string
}): Promise<string> {
  let envelope: PublisherSignatureEnvelope
  try {
    envelope = validatePublisherEnvelope(
      JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(input.signatureBytes)) as unknown,
    )
  } catch (error) {
    throw new Error(`bundle signature entry is invalid: ${(error as Error)?.message ?? error}`)
  }
  input.signedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const expectedPayload = {
    packageName: input.packageName,
    version: input.version,
    manifestSha256: await sha256Hex(utf8(canonicalJson(input.manifest))),
    contentSha256: await sha256Hex(utf8(canonicalJson({schemaVersion: 1, files: input.signedFiles}))),
  }
  if (canonicalJson(envelope.payload) !== canonicalJson(expectedPayload)) {
    throw new Error("bundle signature payload does not match the archive contents")
  }
  const publicKey = decodeBase64Url(envelope.publicKeyJwk.x)
  if (publicKey.byteLength !== nacl.sign.publicKeyLength) throw new Error("bundle publisher public key is invalid")
  const fingerprint = `sha256:${await sha256Hex(publicKey)}`
  if (fingerprint !== envelope.publisherKeyFingerprint) {
    throw new Error("bundle publisher fingerprint does not match its public key")
  }
  const signature = decodeBase64Url(envelope.signature)
  if (signature.byteLength !== nacl.sign.signatureLength) throw new Error("bundle publisher signature is invalid")
  if (!nacl.sign.detached.verify(utf8(canonicalJson(envelope.payload)), signature, publicKey)) {
    throw new Error("bundle publisher signature is invalid")
  }
  return fingerprint
}

interface PublisherSignatureEnvelope {
  schemaVersion: 1
  algorithm: "Ed25519"
  publicKeyJwk: {kty: "OKP"; crv: "Ed25519"; x: string}
  publisherKeyFingerprint: string
  payload: {packageName: string; version: string; manifestSha256: string; contentSha256: string}
  signature: string
}

function validatePublisherEnvelope(value: unknown): PublisherSignatureEnvelope {
  const candidate = value as Partial<PublisherSignatureEnvelope> | null
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    candidate.algorithm !== "Ed25519" ||
    candidate.publicKeyJwk?.kty !== "OKP" ||
    candidate.publicKeyJwk.crv !== "Ed25519" ||
    typeof candidate.publicKeyJwk.x !== "string" ||
    typeof candidate.publisherKeyFingerprint !== "string" ||
    typeof candidate.signature !== "string" ||
    !candidate.payload ||
    typeof candidate.payload.packageName !== "string" ||
    typeof candidate.payload.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.payload.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(candidate.payload.contentSha256)
  ) {
    throw new Error("signature fields are invalid")
  }
  return candidate as PublisherSignatureEnvelope
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("signature encoding is invalid")
  const decoded = Buffer.from(value, "base64url")
  if (decoded.toString("base64url") !== value) throw new Error("signature encoding is not canonical")
  return Uint8Array.from(decoded)
}

/** Recheck the public permission schema at the final ZIP activation boundary. */
export function validateManifestPermissions(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error("bundle manifest permissions must be an array")
  value.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`bundle manifest permissions[${index}] must be an object`)
    }
    const record = candidate as Record<string, unknown>
    if (typeof record.type !== "string" || !AUTHOR_DECLARABLE_PERMISSION_TYPES.has(record.type)) {
      throw new Error(`bundle manifest permissions[${index}].type is invalid`)
    }
    if (record.required !== undefined && typeof record.required !== "boolean") {
      throw new Error(`bundle manifest permissions[${index}].required must be a boolean`)
    }
    if (record.description !== undefined && typeof record.description !== "string") {
      throw new Error(`bundle manifest permissions[${index}].description must be a string`)
    }
  })
}

const AUTHOR_DECLARABLE_HARDWARE_TYPES = new Set<HardwareType>(
  Object.values(HardwareType).filter((type) => type !== HardwareType.EXIST),
)

/** Validate untrusted catalog/ZIP hardware requirements against the public manifest schema. */
export function validateManifestHardwareRequirements(value: unknown): HardwareRequirement[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("bundle manifest hardwareRequirements must be an array")
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`bundle manifest hardwareRequirements[${index}] is invalid`)
    }
    const record = candidate as Record<string, unknown>
    if (typeof record.type !== "string" || !AUTHOR_DECLARABLE_HARDWARE_TYPES.has(record.type as HardwareType)) {
      throw new Error(`bundle manifest hardwareRequirements[${index}].type is invalid`)
    }
    if (record.level !== HardwareRequirementLevel.REQUIRED && record.level !== HardwareRequirementLevel.OPTIONAL) {
      throw new Error(`bundle manifest hardwareRequirements[${index}].level is invalid`)
    }
    if (record.description !== undefined && typeof record.description !== "string") {
      throw new Error(`bundle manifest hardwareRequirements[${index}].description is invalid`)
    }
    return {
      type: record.type as HardwareType,
      level: record.level,
      ...(typeof record.description === "string" ? {description: record.description} : {}),
    }
  })
}

function safePath(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path)) return false
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path
  return normalized.length > 0 && normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}

function isSymlink(entry: JSZip.JSZipObject): boolean {
  const permissions = entry.unixPermissions
  return typeof permissions === "number" && (permissions & 0o170000) === 0o120000
}

type LoadedZipEntry = JSZip.JSZipObject & {
  _data?: {uncompressedSize?: number; crc32?: number}
  internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>
}

function compressedMetadata(entry: JSZip.JSZipObject): {
  uncompressedSize: number
  crc32: number
  verifyCrc: boolean
} {
  const data = (entry as LoadedZipEntry)._data
  const uncompressedSize = data?.uncompressedSize
  const crc = data?.crc32
  // JSZip represents generated implicit directory entries with a promise for
  // empty content rather than compressed metadata. Stream them under a zero
  // byte ceiling, but there is no source CRC to compare.
  if (entry.dir && uncompressedSize === undefined && crc === undefined) {
    return {uncompressedSize: 0, crc32: 0, verifyCrc: false}
  }
  if (!Number.isSafeInteger(uncompressedSize) || (uncompressedSize ?? -1) < 0 || !Number.isInteger(crc)) {
    throw new Error(`bundle ZIP metadata is invalid for ${entry.name}`)
  }
  return {uncompressedSize: uncompressedSize!, crc32: crc! >>> 0, verifyCrc: true}
}

async function verifyEntryStream(
  entry: JSZip.JSZipObject,
  maxOutputBytes: number,
  capture: boolean,
): Promise<Uint8Array | undefined> {
  const expected = compressedMetadata(entry)
  if (expected.uncompressedSize > maxOutputBytes) {
    throw new Error(
      entry.name === "miniapp.json" ? "bundle manifest exceeds the host limit" : "bundle expands beyond the host limit",
    )
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let length = 0
    let crc = 0xffffffff
    let settled = false
    let stream: JSZip.JSZipStreamHelper<Uint8Array>
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      stream?.pause()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    try {
      stream = (entry as LoadedZipEntry).internalStream("uint8array")
      stream
        .on("data", (chunk) => {
          if (settled) return
          length += chunk.byteLength
          if (length > maxOutputBytes || length > expected.uncompressedSize) {
            fail(new Error(`bundle entry expands beyond its declared limit: ${entry.name}`))
            return
          }
          crc = updateCrc32(crc, chunk)
          if (capture) chunks.push(Uint8Array.from(chunk))
        })
        .on("error", fail)
        .on("end", () => {
          if (settled) return
          if (length !== expected.uncompressedSize) {
            fail(new Error(`bundle entry size mismatch: ${entry.name}`))
            return
          }
          const actualCrc = (crc ^ 0xffffffff) >>> 0
          if (expected.verifyCrc && actualCrc !== expected.crc32) {
            fail(new Error(`bundle entry CRC mismatch: ${entry.name}`))
            return
          }
          settled = true
          resolve(capture ? concatenate(chunks, length) : undefined)
        })
        .resume()
    } catch (error) {
      fail(error)
    }
  })
}

function concatenate(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let next = crc
  for (const byte of bytes) next = CRC_TABLE[(next ^ byte) & 0xff]! ^ (next >>> 8)
  return next
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

function inspectCentralDirectory(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEocd(view)
  const entriesOnDisk = readU16(view, eocd + 8)
  const entryCount = readU16(view, eocd + 10)
  const centralSize = readU32(view, eocd + 12)
  const centralOffset = readU32(view, eocd + 16)
  if (readU16(view, eocd + 4) !== 0 || readU16(view, eocd + 6) !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("multi-disk ZIPs are not supported")
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported")
  }
  if (entryCount < 1 || entryCount > MAX_ENTRIES) throw new Error("bundle contains an invalid number of files")
  if (centralOffset + centralSize !== eocd) throw new Error("bundle ZIP central directory is malformed")

  const names = new Set<string>()
  const foldedNames = new Set<string>()
  let expanded = 0
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(view, cursor, 46)
    if (readU32(view, cursor) !== CENTRAL_SIGNATURE) throw new Error("bundle ZIP central entry is malformed")
    const madeBy = readU16(view, cursor + 4)
    const flags = readU16(view, cursor + 8)
    const uncompressedSize = readU32(view, cursor + 24)
    const nameLength = readU16(view, cursor + 28)
    const extraLength = readU16(view, cursor + 30)
    const commentLength = readU16(view, cursor + 32)
    const externalAttributes = readU32(view, cursor + 38)
    const nameStart = cursor + 46
    requireRange(view, nameStart, nameLength + extraLength + commentLength)
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength)
    if ((flags & (1 << 11)) === 0 && nameBytes.some((byte) => byte >= 0x80)) {
      throw new Error("non-UTF-8 ZIP filenames are not supported")
    }
    const name = new TextDecoder("utf-8", {fatal: true}).decode(nameBytes)
    if (!safePath(name)) throw new Error(`bundle contains an unsafe path: ${name}`)
    if (names.has(name)) throw new Error(`bundle contains a duplicate path: ${name}`)
    if (foldedNames.has(name.toLowerCase())) throw new Error(`bundle contains a case-colliding path: ${name}`)
    names.add(name)
    foldedNames.add(name.toLowerCase())
    const creatorOs = madeBy >>> 8
    const unixMode = externalAttributes >>> 16
    if (creatorOs === 3 && (unixMode & 0o170000) === 0o120000) {
      throw new Error(`bundle contains a symbolic link: ${name}`)
    }
    expanded += uncompressedSize
    if (expanded > MAX_EXPANDED_BYTES) throw new Error("bundle expands beyond the host limit")
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  if (cursor !== centralOffset + centralSize) throw new Error("bundle ZIP central directory size is inconsistent")
}

function findEocd(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - (0xffff + 22))
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readU32(view, offset) !== EOCD_SIGNATURE) continue
    if (offset + 22 + readU16(view, offset + 20) === view.byteLength) return offset
  }
  throw new Error("bundle ZIP end record was not found")
}

function requireRange(view: DataView, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) {
    throw new Error("bundle ZIP structure points outside the archive")
  }
}

function readU16(view: DataView, offset: number): number {
  requireRange(view, offset, 2)
  return view.getUint16(offset, true)
}

function readU32(view: DataView, offset: number): number {
  requireRange(view, offset, 4)
  return view.getUint32(offset, true)
}
