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

export interface LoadedMediaMetadata {
  actualSize?: number
  exif: Record<string, unknown> | null
}

// JPEG EXIF data lives in APP1 segments, whose payload is limited to 64 KiB.
// Leave room for other leading JPEG segments without copying the entire image
// into a base64 string and then into a second binary buffer.
const MAX_METADATA_READ_BYTES = 512 * 1024

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

  try {
    const bytesToRead = Math.min(
      actualSize && actualSize > 0 ? actualSize : MAX_METADATA_READ_BYTES,
      MAX_METADATA_READ_BYTES,
    )
    const base64 = await RNFS.read(path, bytesToRead, 0, "base64")
    const exif = await parse(Buffer.from(base64, "base64"))
    return {actualSize, exif: exif && typeof exif === "object" ? (exif as Record<string, unknown>) : null}
  } catch (error) {
    // A valid image often has no EXIF block. Keep the core file details usable
    // and treat parser failures as an empty EXIF section.
    console.info(`[GalleryMetadata] No readable EXIF metadata for ${photo.name}:`, error)
    return {actualSize, exif: null}
  }
}
