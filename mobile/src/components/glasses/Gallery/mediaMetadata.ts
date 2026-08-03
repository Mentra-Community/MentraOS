import {PhotoInfo} from "@/types/asg"

export interface MediaDimensions {
  width: number
  height: number
}

export interface MetadataRow {
  label: string
  value: string
}

const BINARY_EXIF_FIELDS = new Set(["MakerNote", "UserComment", "thumbnail", "Thumbnail", "image"])

export function formatFileSize(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "Unknown"
  if (bytes < 1024) return `${bytes} B`

  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`
}

export function formatMediaDuration(milliseconds?: number): string | null {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return null
  const totalSeconds = Math.round(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export function formatMediaDate(value?: string | number): string | null {
  if (value == null) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}

export function getMediaFilename(photo: PhotoInfo): string {
  const path = photo.filePath || photo.download || photo.url
  const pathFilename = path?.split(/[\\/]/).pop()?.split("?")[0]
  return pathFilename || photo.name.split(/[\\/]/).pop() || photo.name
}

function humanizeExifLabel(key: string): string {
  return key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase())
}

function stringifyExifValue(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toLocaleString()
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim()
    return text.length > 0 ? text : null
  }
  if (Array.isArray(value)) {
    const values = value.map(stringifyExifValue).filter((item): item is string => item != null)
    return values.length > 0 ? values.join(", ") : null
  }
  return null
}

export function flattenExifMetadata(exif: Record<string, unknown> | null | undefined): MetadataRow[] {
  if (!exif) return []

  return Object.entries(exif)
    .filter(([key]) => !BINARY_EXIF_FIELDS.has(key))
    .map(([key, value]) => ({label: humanizeExifLabel(key), value: stringifyExifValue(value)}))
    .filter((row): row is MetadataRow => row.value != null)
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function buildMediaDetails(photo: PhotoInfo, dimensions?: MediaDimensions, actualSize?: number): MetadataRow[] {
  const rows: Array<MetadataRow | null> = [
    {label: "Filename", value: getMediaFilename(photo)},
    {label: "Media type", value: photo.mime_type || (photo.is_video ? "video/mp4" : "image/jpeg")},
    dimensions ? {label: "Resolution", value: `${dimensions.width} × ${dimensions.height}`} : null,
    {label: "File size", value: formatFileSize(actualSize ?? photo.size)},
    formatMediaDate(photo.modified) ? {label: "Captured", value: formatMediaDate(photo.modified)!} : null,
    photo.downloaded_at && formatMediaDate(photo.downloaded_at)
      ? {label: "Downloaded", value: formatMediaDate(photo.downloaded_at)!}
      : null,
    photo.glassesModel ? {label: "Captured with", value: photo.glassesModel} : null,
    formatMediaDuration(photo.duration) ? {label: "Duration", value: formatMediaDuration(photo.duration)!} : null,
  ]

  return rows.filter((row): row is MetadataRow => row != null)
}
