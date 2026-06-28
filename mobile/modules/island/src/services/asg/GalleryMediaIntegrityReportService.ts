import {submitAutomaticReport, type ReportSubmitResult} from "../../facades/reports"
import type {MediaKind} from "./galleryMediaValidation"

const LOG_TAG = "GalleryMediaIntegrityReport"
const DEDUPE_WINDOW_MS = 90_000

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

function buildSubmitStatus(result: ReportSubmitResult):
  | {status: "filed"; reportId: string}
  | {status: "skipped"; reason: string}
  | {status: "failed"; error: string} {
  if (result.status === "submitted") {
    return {status: "filed", reportId: result.reportId}
  }
  if (result.status === "skipped") {
    return {status: "skipped", reason: result.reason}
  }
  return {status: "failed", error: result.error}
}

export function galleryMediaIntegrityDedupeKey(input: InvalidGalleryMediaReportInput): string {
  return ["gallery_media_integrity", input.mediaKind, input.stage, input.captureId || input.name, input.reason].join("|")
}

export async function submitInvalidGalleryMediaReport(
  input: InvalidGalleryMediaReportInput,
): Promise<ReturnType<typeof buildSubmitStatus>> {
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
    dedupeKey: galleryMediaIntegrityDedupeKey(input),
    dedupeWindowMs: DEDUPE_WINDOW_MS,
  })

  const status = buildSubmitStatus(result)
  if (status.status === "filed") {
    console.log(`[${LOG_TAG}] Report filed:`, status.reportId)
  } else if (status.status === "skipped") {
    console.log(`[${LOG_TAG}] Skipping duplicate within window:`, input.name)
  } else {
    console.error(`[${LOG_TAG}] submit failed:`, status.error)
  }
  return status
}

export function reportInvalidGalleryMedia(input: InvalidGalleryMediaReportInput): void {
  void submitInvalidGalleryMediaReport(input).catch((error) => {
    console.error(`[${LOG_TAG}] Unexpected error:`, error)
  })
}
