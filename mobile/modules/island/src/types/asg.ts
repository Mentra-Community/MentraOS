/**
 * Gallery / ASG HTTP-API types (relocated from the host `@/types/asg`). `PhotoInfo`
 * lives with the gallerySync store that owns it; the rest describe the glasses'
 * on-device camera HTTP API that asgCameraApi talks to. The host `@/types/asg`
 * re-exports these from `@mentra/island` so existing importers stay unchanged.
 */
import type {PhotoInfo} from "../stores/gallerySync"
export type {PhotoInfo}

export interface CaptureFile {
  name: string // "IMG_xxx/base.jpg" or "IMG_xxx.jpg" (legacy)
  size: number
  role: "primary" | "bracket" | "sidecar"
}

export interface CaptureGroup {
  capture_id: string // folder name: "IMG_20250302_143022_456_123"
  type: "photo" | "video"
  timestamp: number
  total_size: number
  files: CaptureFile[]
  thumbnail_data?: string
  duration?: number // video only
}

export interface GalleryResponse {
  status: "success" | "error"
  data: {
    photos: PhotoInfo[]
  }
}

export interface ServerStatus {
  status: string
  uptime: number
  version: string
  timestamp: string
}

export interface HealthResponse {
  status: "healthy" | "unhealthy"
  timestamp: string
  version: string
}

export interface GalleryEvent {
  type: "photo_added" | "photo_deleted" | "gallery_updated"
  photo?: PhotoInfo
  timestamp: string
}
