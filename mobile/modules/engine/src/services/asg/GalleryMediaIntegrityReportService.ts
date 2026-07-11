import {submitAutomaticReport} from "../../facades/reports"
import {
  logAutomaticReportSubmissionStatus,
  type AutomaticReportSubmissionStatus,
  toAutomaticReportSubmissionStatus,
} from "../AutomaticReportResult"
import type {MediaKind} from "./galleryMediaValidation"

const LOG_TAG = "GalleryMediaIntegrityReport"
const THROTTLE_WINDOW_MS = 90_000

export interface InvalidGalleryMediaReportInput {
  name: string
  reason: string
  stage: "capture_metadata_validation" | "download_validation" | "download_capture_validation" | "processing_validation"
  mediaKind: MediaKind
  path?: string
  expectedSize?: number
  captureId?: string
  duration?: number
  glassesModel?: string
}

export function galleryMediaIntegrityThrottleKey(input: InvalidGalleryMediaReportInput): string {
  return ["gallery_media_integrity", input.mediaKind, input.stage, input.captureId || input.name, input.reason].join("|")
}

export async function submitInvalidGalleryMediaReport(
  input: InvalidGalleryMediaReportInput,
): Promise<AutomaticReportSubmissionStatus> {
  const result = await submitAutomaticReport({
    kind: "automatic",
    trigger: {
      type: "automatic",
      source: "gallery_media_integrity",
      reason: "invalid_downloaded_media",
    },
    report: {
      expectedBehavior: "Gallery media synced from glasses should be valid before it is shown in the gallery.",
      actualBehavior: JSON.stringify(
        {
          name: input.name,
          captureId: input.captureId,
          mediaKind: input.mediaKind,
          stage: input.stage,
          reason: input.reason,
          path: input.path,
          expectedSize: input.expectedSize,
          duration: input.duration,
          glassesModel: input.glassesModel,
        },
        null,
        2,
      ),
      systemPriority: input.mediaKind === "video" ? "high" : "medium",
    },
    throttleKey: galleryMediaIntegrityThrottleKey(input),
    throttleWindowMs: THROTTLE_WINDOW_MS,
  })

  const status = toAutomaticReportSubmissionStatus(result)
  logAutomaticReportSubmissionStatus(LOG_TAG, status, input.name)
  return status
}

export function reportInvalidGalleryMedia(input: InvalidGalleryMediaReportInput): void {
  void submitInvalidGalleryMediaReport(input).catch((error) => {
    console.error(`[${LOG_TAG}] Unexpected error:`, error)
  })
}
