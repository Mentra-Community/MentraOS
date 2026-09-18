import {createHash} from "node:crypto"
import {inflateRawSync} from "node:zlib"

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const UTF8_FLAG = 1 << 11
const ENCRYPTED_FLAG = 1

export interface VerifiedZipEntry {
  name: string
  directory: boolean
  uncompressedSize: number
  sha256: string
  bytes?: Uint8Array
}

export interface VerifyZipOptions {
  maxEntries: number
  maxExpandedBytes: number
  maxEntryBytes?: (name: string) => number | undefined
  capture: (name: string) => boolean
  validatePath: (name: string) => boolean
}

/**
 * Verify a classic ZIP without allowing CRC validation to inflate beyond the
 * configured ceiling. ZIP64 and multi-disk archives are unnecessary for
 * miniapps and intentionally rejected to keep the parser auditable.
 */
export function verifyZipArchive(bundle: Uint8Array, options: VerifyZipOptions): Map<string, VerifiedZipEntry> {
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength)
  const eocdOffset = findEocd(view)
  const disk = u16(view, eocdOffset + 4)
  const centralDisk = u16(view, eocdOffset + 6)
  const entriesOnDisk = u16(view, eocdOffset + 8)
  const entryCount = u16(view, eocdOffset + 10)
  const centralSize = u32(view, eocdOffset + 12)
  const centralOffset = u32(view, eocdOffset + 16)
  const commentLength = u16(view, eocdOffset + 20)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount)
    throw new Error("multi-disk ZIPs are not supported")
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported")
  }
  if (entryCount < 1 || entryCount > options.maxEntries) throw new Error("bundle contains an invalid entry count")
  if (eocdOffset + 22 + commentLength !== view.byteLength) throw new Error("ZIP end record is malformed")
  if (centralOffset + centralSize !== eocdOffset) throw new Error("ZIP central directory is malformed")

  const entries = new Map<string, VerifiedZipEntry>()
  const caseFoldedNames = new Set<string>()
  let cursor = centralOffset
  let expandedBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(view, cursor, 46)
    if (u32(view, cursor) !== CENTRAL_SIGNATURE) throw new Error("ZIP central entry is malformed")
    const madeBy = u16(view, cursor + 4)
    const flags = u16(view, cursor + 8)
    const method = u16(view, cursor + 10)
    const expectedCrc = u32(view, cursor + 16)
    const compressedSize = u32(view, cursor + 20)
    const uncompressedSize = u32(view, cursor + 24)
    const nameLength = u16(view, cursor + 28)
    const extraLength = u16(view, cursor + 30)
    const entryCommentLength = u16(view, cursor + 32)
    const startDisk = u16(view, cursor + 34)
    const externalAttributes = u32(view, cursor + 38)
    const localOffset = u32(view, cursor + 42)
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff) || startDisk !== 0) {
      throw new Error("ZIP64 or multi-disk entries are not supported")
    }
    if ((flags & ENCRYPTED_FLAG) !== 0) throw new Error("encrypted ZIP entries are not supported")
    if (method !== 0 && method !== 8) throw new Error(`unsupported ZIP compression method ${method}`)

    const nameStart = cursor + 46
    requireRange(view, nameStart, nameLength + extraLength + entryCommentLength)
    const nameBytes = bundle.subarray(nameStart, nameStart + nameLength)
    const name = decodeName(nameBytes, (flags & UTF8_FLAG) !== 0)
    if (!options.validatePath(name)) throw new Error(`bundle contains an unsafe path: ${name}`)
    if (entries.has(name)) throw new Error(`bundle contains a duplicate path: ${name}`)
    if (caseFoldedNames.has(name.toLowerCase())) throw new Error(`bundle contains a case-colliding path: ${name}`)
    caseFoldedNames.add(name.toLowerCase())
    const directory = name.endsWith("/")
    const creatorOs = madeBy >>> 8
    const unixMode = externalAttributes >>> 16
    if (creatorOs === 3 && (unixMode & 0o170000) === 0o120000) {
      throw new Error(`bundle contains a symbolic link: ${name}`)
    }

    const entryLimit = options.maxEntryBytes?.(name)
    if (entryLimit !== undefined && uncompressedSize > entryLimit) {
      throw new Error(`ZIP entry exceeds its configured limit: ${name}`)
    }

    expandedBytes += uncompressedSize
    if (expandedBytes > options.maxExpandedBytes) throw new Error("bundle expands beyond the configured limit")

    requireRange(view, localOffset, 30)
    if (u32(view, localOffset) !== LOCAL_SIGNATURE) throw new Error("ZIP local entry is malformed")
    const localFlags = u16(view, localOffset + 6)
    const localMethod = u16(view, localOffset + 8)
    const localNameLength = u16(view, localOffset + 26)
    const localExtraLength = u16(view, localOffset + 28)
    const localNameStart = localOffset + 30
    requireRange(view, localNameStart, localNameLength + localExtraLength)
    const localName = decodeName(
      bundle.subarray(localNameStart, localNameStart + localNameLength),
      (localFlags & UTF8_FLAG) !== 0,
    )
    if (localName !== name || localMethod !== method || (localFlags & ENCRYPTED_FLAG) !== 0) {
      throw new Error(`ZIP local and central entries disagree for ${name}`)
    }
    const dataStart = localNameStart + localNameLength + localExtraLength
    requireRange(view, dataStart, compressedSize)
    if (dataStart + compressedSize > centralOffset) throw new Error(`ZIP entry overlaps its central directory: ${name}`)

    const compressed = bundle.subarray(dataStart, dataStart + compressedSize)
    let output: Uint8Array
    try {
      if (method === 0) {
        if (compressedSize !== uncompressedSize) throw new Error("stored entry size mismatch")
        output = compressed
      } else {
        const remaining = options.maxExpandedBytes - (expandedBytes - uncompressedSize)
        const maxOutputLength = Math.max(
          1,
          Math.min(uncompressedSize + 1, remaining + 1, entryLimit === undefined ? Infinity : entryLimit + 1),
        )
        output = inflateRawSync(compressed, {maxOutputLength})
      }
    } catch (error) {
      throw new Error(`could not safely inflate ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (output.byteLength !== uncompressedSize) throw new Error(`ZIP entry size mismatch for ${name}`)
    if (crc32(output) !== expectedCrc) throw new Error(`ZIP entry CRC mismatch for ${name}`)
    entries.set(name, {
      name,
      directory,
      uncompressedSize,
      sha256: createHash("sha256").update(output).digest("hex"),
      ...(options.capture(name) ? {bytes: Uint8Array.from(output)} : {}),
    })
    cursor = nameStart + nameLength + extraLength + entryCommentLength
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP central directory size is inconsistent")
  return entries
}

function findEocd(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - (0xffff + 22))
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (u32(view, offset) !== EOCD_SIGNATURE) continue
    const commentLength = u16(view, offset + 20)
    if (offset + 22 + commentLength === view.byteLength) return offset
  }
  throw new Error("ZIP end record not found")
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) throw new Error("non-UTF-8 ZIP filenames are not supported")
  try {
    return new TextDecoder("utf-8", {fatal: true}).decode(bytes)
  } catch {
    throw new Error("ZIP filename is not valid UTF-8")
  }
}

function requireRange(view: DataView, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > view.byteLength
  ) {
    throw new Error("ZIP structure points outside the uploaded bundle")
  }
}

function u16(view: DataView, offset: number): number {
  requireRange(view, offset, 2)
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  requireRange(view, offset, 4)
  return view.getUint32(offset, true)
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
