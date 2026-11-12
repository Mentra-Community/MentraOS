import * as RNFS from "@dr.pogodin/react-native-fs"
import {Buffer} from "@craftzdog/react-native-buffer"
import {parse} from "exifr/src/bundles/nano.mjs"
import "exifr/src/dicts/tiff-exif-keys.mjs"
import "exifr/src/dicts/tiff-exif-values.mjs"
import "exifr/src/dicts/tiff-gps-keys.mjs"
import "exifr/src/dicts/tiff-ifd0-keys.mjs"
import "exifr/src/dicts/tiff-ifd0-values.mjs"
import "exifr/src/dicts/tiff-revivers.mjs"

import {PhotoInfo} from "@/types/asg"

import {MediaDimensions} from "./mediaMetadata"

export interface LoadedMediaMetadata {
  actualSize?: number
  // Pixel size stored in the file, oriented for display.
  dimensions?: MediaDimensions
  exif: Record<string, unknown> | null
}

// JPEG EXIF data lives in APP1 segments, whose payload is limited to 64 KiB.
// Leave room for other leading JPEG segments without copying the entire image
// into a base64 string and then into a second binary buffer.
const MAX_METADATA_READ_BYTES = 512 * 1024

// SOF0-SOF15 carry the frame size. 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC) share
// the range but are not frame headers.
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

/**
 * Read a JPEG's pixel size from its frame header. Unlike EXIF, every JPEG has
 * one, including photos re-encoded by on-phone processing.
 */
export function readJpegDimensions(bytes: Uint8Array): MediaDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      // Fill byte before a marker.
      offset += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // Standalone markers have no length field.
      offset += 2
      continue
    }
    // Image data or the end of the image comes after the frame header.
    if (marker === 0xda || marker === 0xd9) return null

    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (length < 2) return null
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) return null
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6]
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8]
      return width > 0 && height > 0 ? {width, height} : null
    }
    offset += 2 + length
  }
  return null
}

// EXIF orientations 5-8 display the stored pixels turned a quarter turn. The
// parser translates the tag to text such as "Rotate 90 CW".
function isQuarterTurn(orientation: unknown): boolean {
  if (typeof orientation === "number") return orientation >= 5 && orientation <= 8
  return typeof orientation === "string" && /rotate (90|270) cw/i.test(orientation)
}

function getLocalFilePath(photo: PhotoInfo): string | null {
  const uri = photo.filePath || photo.download || photo.url
  if (!uri || (!uri.startsWith("/") && !uri.startsWith("file://"))) return null
  const path = uri.replace(/^file:\/\//, "")
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export async function loadMediaMetadata(photo: PhotoInfo): Promise<LoadedMediaMetadata> {
  const path = getLocalFilePath(photo)
  if (!path) return {exif: null}

  let actualSize: number | undefined
  try {
    actualSize = Number((await RNFS.stat(path)).size)
  } catch (error) {
    console.warn(`[GalleryMetadata] Could not stat ${photo.name}:`, error)
  }

  if (photo.is_video || photo.mime_type?.startsWith("video/")) return {actualSize, exif: null}

  let bytes: Uint8Array
  try {
    const bytesToRead = Math.min(
      actualSize && actualSize > 0 ? actualSize : MAX_METADATA_READ_BYTES,
      MAX_METADATA_READ_BYTES,
    )
    bytes = Buffer.from(await RNFS.read(path, bytesToRead, 0, "base64"), "base64")
  } catch (error) {
    console.warn(`[GalleryMetadata] Could not read ${photo.name}:`, error)
    return {actualSize, exif: null}
  }

  let exif: Record<string, unknown> | null = null
  try {
    const parsed = await parse(bytes)
    exif = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch (error) {
    // A valid image often has no EXIF block. Keep the core file details usable
    // and treat parser failures as an empty EXIF section.
    console.info(`[GalleryMetadata] No readable EXIF metadata for ${photo.name}:`, error)
  }

  const stored = readJpegDimensions(bytes)
  const dimensions =
    stored && isQuarterTurn(exif?.Orientation) ? {width: stored.height, height: stored.width} : (stored ?? undefined)
  return {actualSize, dimensions, exif}
}
