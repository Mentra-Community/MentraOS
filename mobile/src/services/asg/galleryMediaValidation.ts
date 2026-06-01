/**
 * Post-download validation for gallery media synced from glasses.
 */

import * as RNFS from "@dr.pogodin/react-native-fs"
import {Buffer} from "buffer"

export const INVALID_DOWNLOADED_MEDIA = "Invalid downloaded media"

export type MediaKind = "photo" | "video" | "unknown"

export interface ValidateDownloadedMediaOptions {
  path: string
  name: string
  expectedSize?: number
  mediaKind?: MediaKind
}

// ISO BMFF brands that identify still-image (not video) containers. An mp4-like
// header with one of these brands at bytes 8-11 must NOT pass video validation.
const IMAGE_FTYP_BRANDS = new Set(["avif", "avis", "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"])

function isVideoFileName(name: string): boolean {
  return /\.(mp4|mov|avi|webm|mkv|3gp)$/i.test(name)
}

function isPhotoFileName(name: string): boolean {
  return /\.(jpg|jpeg|png|avif)$/i.test(name) || !name.includes(".")
}

function detectMediaKind(name: string, override?: MediaKind): MediaKind {
  if (override && override !== "unknown") {
    return override
  }
  if (isVideoFileName(name)) {
    return "video"
  }
  if (isPhotoFileName(name)) {
    return "photo"
  }
  return "unknown"
}

function decodeHeader(base64Header: string): Buffer {
  // Use Buffer (from the "buffer" polyfill) for byte-safe decoding; RN's atob
  // is host-dependent and some implementations mangle bytes ≥ 0x80, which would
  // mis-validate JPEG (0xFF 0xD8) and binary AVI/EBML headers.
  return Buffer.from(base64Header, "base64")
}

function readAscii(bytes: Buffer, start: number, length: number): string {
  if (bytes.length < start + length) return ""
  return bytes.toString("ascii", start, start + length)
}

function validatePhotoSignature(base64Header: string): boolean {
  try {
    const bytes = decodeHeader(base64Header)
    if (bytes.length >= 12 && readAscii(bytes, 4, 4) === "ftyp") {
      const brand = readAscii(bytes, 8, 4)
      // Image-only ISO BMFF brands (AVIF, HEIC, HEIF variants) are valid photos.
      if (IMAGE_FTYP_BRANDS.has(brand)) {
        return true
      }
    }
    // JPEG: 0xFF 0xD8
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      return true
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return true
    }
    return false
  } catch {
    return false
  }
}

function validateVideoSignature(base64Header: string): boolean {
  try {
    const bytes = decodeHeader(base64Header)
    if (bytes.length < 8) {
      return false
    }
    // ISO BMFF (mp4, mov, 3gp): bytes 4-7 should be "ftyp" AND brand at 8-11 must
    // not be an image-only brand (AVIF/HEIC share the ftyp container).
    if (readAscii(bytes, 4, 4) === "ftyp") {
      const brand = readAscii(bytes, 8, 4)
      if (IMAGE_FTYP_BRANDS.has(brand)) {
        return false
      }
      return true
    }
    // RIFF/AVI: bytes 0-3 "RIFF", bytes 8-11 "AVI "
    if (bytes.length >= 12 && readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "AVI ") {
      return true
    }
    // EBML (WebM, MKV): bytes 0-3 are 0x1A 0x45 0xDF 0xA3
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Validate a downloaded file on disk. Throws with INVALID_DOWNLOADED_MEDIA on failure.
 */
export async function validateDownloadedMediaFile(options: ValidateDownloadedMediaOptions): Promise<void> {
  const {path, name, expectedSize = 0, mediaKind} = options

  const exists = await RNFS.exists(path)
  if (!exists) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: missing file ${name}`)
  }

  const stat = await RNFS.stat(path)
  if (stat.size === 0) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: zero-byte file ${name}`)
  }

  if (expectedSize > 0 && stat.size !== expectedSize) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: size mismatch for ${name}: expected ${expectedSize}, got ${stat.size}`)
  }

  const kind = detectMediaKind(name, mediaKind)
  if (kind === "unknown") {
    return
  }

  const headerBase64 = await RNFS.read(path, 12, 0, "base64")
  if (kind === "video") {
    if (!validateVideoSignature(headerBase64)) {
      throw new Error(`${INVALID_DOWNLOADED_MEDIA}: invalid video container for ${name}`)
    }
    return
  }

  if (!validatePhotoSignature(headerBase64)) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: invalid photo signature for ${name}`)
  }
}

/**
 * Pre-download check using sync metadata before hitting the network.
 */
export function validateCaptureMetadataForDownload(capture: {
  capture_id: string
  type: "photo" | "video"
  total_size: number
  files: Array<{name: string; size: number; role: string}>
}): void {
  if (capture.type !== "video") {
    return
  }

  if (capture.total_size <= 0) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: video capture ${capture.capture_id} has zero total_size`)
  }

  const primaryFile = capture.files.find((f) => f.role === "primary") ?? capture.files[0]
  if (!primaryFile) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: video capture ${capture.capture_id} has no files`)
  }
  if (primaryFile.size <= 0) {
    throw new Error(
      `${INVALID_DOWNLOADED_MEDIA}: video capture ${capture.capture_id} primary file ${primaryFile.name} has zero size`,
    )
  }
}
