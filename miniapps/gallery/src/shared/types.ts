/**
 * Shared types — imported by BOTH the background JSContext and the UI WebView.
 * The bundler inlines these into each bundle so the channel-bus payload shapes
 * are compile-time consistent on both sides.
 */

export type PhotoSize = "low" | "medium" | "high" | "max"
export type GalleryFilter = "all" | "photos" | "videos"

export interface GallerySettings {
  /** Also save captures to the phone's native camera roll. */
  saveToCameraRoll: boolean
  photoSize: PhotoSize
}

export interface PhotoItem {
  /** Blob key. */
  id: string
  /** Epoch milliseconds. */
  createdAt: number
  mimeType: string
  /** Size on disk, bytes. */
  bytes: number
  /** Set for video items (drives the play badge + duration). Undefined = photo. */
  durationMs?: number
  favorite: boolean
  /**
   * Fresh cloud URL (https, ~30 min TTL) — present only for a just-captured
   * photo. Durable display goes through the `gal:bytes` RPC.
   */
  url?: string
}

export interface Usage {
  bytes: number
  count: number
  quotaBytes: number
}

export interface GallerySnapshot {
  photos: PhotoItem[]
  settings: GallerySettings
  usage: Usage
  capturing: boolean
  hasCamera: boolean
}

export interface CaptureStatus {
  capturing: boolean
  savedId?: string | null
  error?: string | null
}
