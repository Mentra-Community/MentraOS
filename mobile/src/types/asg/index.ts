/**
 * Type definitions for the ASG package.
 *
 * These moved into `@mentra/engine` (with the gallerySync store + asgCameraApi that own
 * them); this host module re-exports them so existing `@/types/asg` importers stay
 * unchanged.
 */
export type {
  PhotoInfo,
  CaptureFile,
  CaptureGroup,
  GalleryResponse,
  ServerStatus,
  HealthResponse,
  GalleryEvent,
} from "@mentra/engine"
