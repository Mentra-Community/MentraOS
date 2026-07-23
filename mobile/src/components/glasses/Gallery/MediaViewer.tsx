/**
 * Media viewer component - simplified wrapper around AwesomeGalleryViewer
 * Handles both images and videos with smooth 60fps swiping
 */

import {memo} from "react"

import {PhotoInfo} from "@/types/asg"

import {AwesomeGalleryViewer} from "./AwesomeGalleryViewer"

interface MediaViewerProps {
  visible: boolean
  photo: PhotoInfo | null
  photos?: PhotoInfo[] // Array of all photos for swiping
  initialIndex?: number // Starting index in photos array
  onClose: () => void
  onShare?: (photo: PhotoInfo) => void
  onDelete?: () => void
}

export const MediaViewer = memo(function MediaViewer({
  visible,
  photo,
  photos,
  initialIndex = 0,
  onClose,
  onShare,
  onDelete: _onDelete,
}: MediaViewerProps) {
  // If photos array is provided, use gallery mode
  const isGalleryMode = photos && photos.length > 0
  const displayPhotos = isGalleryMode ? photos : photo ? [photo] : []

  if (displayPhotos.length === 0) {
    return null
  }

  // Use AwesomeGalleryViewer for everything (images, videos, mixed)
  return (
    <AwesomeGalleryViewer
      visible={visible}
      photos={displayPhotos}
      initialIndex={initialIndex}
      onClose={onClose}
      onShare={onShare}
    />
  )
})
