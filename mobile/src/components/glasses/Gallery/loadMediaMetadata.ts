import * as RNFS from "@dr.pogodin/react-native-fs"
import {Buffer} from "@craftzdog/react-native-buffer"
import {parse} from "exifr/dist/lite.esm.js"

import {PhotoInfo} from "@/types/asg"

export interface LoadedMediaMetadata {
  actualSize?: number
  exif: Record<string, unknown> | null
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

  try {
    const base64 = await RNFS.readFile(path, "base64")
    const exif = await parse(Buffer.from(base64, "base64"))
    return {actualSize, exif: exif && typeof exif === "object" ? (exif as Record<string, unknown>) : null}
  } catch (error) {
    // A valid image often has no EXIF block. Keep the core file details usable
    // and treat parser failures as an empty EXIF section.
    console.info(`[GalleryMetadata] No readable EXIF metadata for ${photo.name}:`, error)
    return {actualSize, exif: null}
  }
}
