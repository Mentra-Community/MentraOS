/**
 * Type definitions for the ASG package
 */

export interface PhotoInfo {
  name: string
  url: string
  download: string
  size: number
  modified: string | number // Unix timestamp (milliseconds) - can be string or number from API
  mime_type?: string
  is_video?: boolean
  thumbnail_data?: string
  downloaded_at?: number
  // New fields for filesystem storage
  filePath?: string
  thumbnailPath?: string
  // Glasses model that captured this media
  glassesModel?: string
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
