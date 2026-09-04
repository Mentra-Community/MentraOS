const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const MAX_ENTRIES = 4_096
const MAX_ENTRY_BYTES = 32 * 1024 * 1024
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024

/** Validate ZIP metadata before handing untrusted workspace bytes to native unzip. */
export function preflightMiniappZip(bytes: Uint8Array): void {
  if (bytes.byteLength < 22) throw new Error("bundle is not a ZIP archive")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdOffset = findEndOfCentralDirectory(view)
  const diskNumber = view.getUint16(eocdOffset + 4, true)
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true)
  const diskEntryCount = view.getUint16(eocdOffset + 8, true)
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirectoryBytes = view.getUint32(eocdOffset + 12, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== entryCount) {
    throw new Error("multi-disk ZIP bundles are not supported")
  }
  if (entryCount === 0 || entryCount > MAX_ENTRIES) throw new Error("bundle contains an invalid number of files")
  if (centralDirectoryOffset + centralDirectoryBytes > eocdOffset) {
    throw new Error("bundle has an invalid central directory")
  }

  const names = new Set<string>()
  const decoder = new TextDecoder("utf-8", {fatal: true})
  let expandedBytes = 0
  let offset = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("bundle has an invalid central directory entry")
    }
    const flags = view.getUint16(offset + 8, true)
    const compressionMethod = view.getUint16(offset + 10, true)
    const expandedEntryBytes = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const externalAttributes = view.getUint32(offset + 38, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > bytes.byteLength || nameLength === 0) throw new Error("bundle has a truncated file record")
    if ((flags & 0x1) !== 0) throw new Error("encrypted bundle entries are not supported")
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error("bundle uses an unsupported compression method")
    }
    if (expandedEntryBytes === 0xffffffff) throw new Error("ZIP64 bundle entries are not supported")
    if (expandedEntryBytes > MAX_ENTRY_BYTES) throw new Error("bundle contains an oversized file")
    expandedBytes += expandedEntryBytes
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error("bundle expands beyond the allowed size")

    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const name = decoder.decode(rawName)
    validateArchivePath(name)
    validateLocalFileHeader(bytes, view, localHeaderOffset, centralDirectoryOffset, rawName)
    if (names.has(name)) throw new Error(`bundle contains duplicate path ${name}`)
    names.add(name)

    const unixMode = externalAttributes >>> 16
    if ((unixMode & 0xf000) === 0xa000) throw new Error("bundle symlinks are not supported")
    offset = nextOffset
  }
  if (offset !== centralDirectoryOffset + centralDirectoryBytes) {
    throw new Error("bundle central directory size does not match its entries")
  }
}

function validateLocalFileHeader(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  centralDirectoryOffset: number,
  centralName: Uint8Array,
): void {
  if (offset + 30 > centralDirectoryOffset || view.getUint32(offset, true) !== LOCAL_FILE_SIGNATURE) {
    throw new Error("bundle has an invalid local file header")
  }
  const nameLength = view.getUint16(offset + 26, true)
  const extraLength = view.getUint16(offset + 28, true)
  const nameStart = offset + 30
  const recordEnd = nameStart + nameLength + extraLength
  if (recordEnd > centralDirectoryOffset || nameLength !== centralName.byteLength) {
    throw new Error("bundle local filename does not match its directory entry")
  }
  const localName = bytes.subarray(nameStart, nameStart + nameLength)
  for (let index = 0; index < centralName.byteLength; index += 1) {
    if (localName[index] !== centralName[index]) {
      throw new Error("bundle local filename does not match its directory entry")
    }
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 65_557)
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue
    const commentLength = view.getUint16(offset + 20, true)
    if (offset + 22 + commentLength === view.byteLength) return offset
  }
  throw new Error("bundle ZIP directory is missing")
}

function validateArchivePath(name: string): void {
  if (name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`bundle contains unsafe path ${name}`)
  }
  const parts = name.split("/")
  if (parts.some((part) => part === ".." || part === ".")) {
    throw new Error(`bundle contains unsafe path ${name}`)
  }
}
