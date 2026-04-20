import restComms from "@/services/RestComms"
import type {PhotoInfo} from "@/types/asg"
import {submitCategorizedBugIncident} from "./automaticBugReport"
import {
  GALLERY_VIDEO_REPORT_DEDUPE_MS,
  galleryVideoIncidentDedupeKey,
  galleryVideoReportDedupeShouldSkip,
  serializeReactNativeVideoOnError,
  uriSchemeFromPlaybackUrl,
} from "./galleryVideoPlaybackBugReportCore"

export {
  GALLERY_VIDEO_REPORT_DEDUPE_MS,
  galleryVideoIncidentDedupeKey,
  galleryVideoReportDedupeShouldSkip,
  serializeReactNativeVideoOnError,
} from "./galleryVideoPlaybackBugReportCore"
export type {SerializedVideoPlayerError} from "./galleryVideoPlaybackBugReportCore"

const reportDedupeRegistry = new Map<string, number>()

/** Clears in-memory dedupe map (for integration tests only). */
export function resetGalleryVideoReportDedupeRegistryForTests(): void {
  reportDedupeRegistry.clear()
}

/**
 * Fire-and-forget from gallery Video onError: same incident pipeline as Feedback (severity 5).
 */
export async function submitGalleryVideoPlaybackBugReport(
  photo: PhotoInfo,
  error: unknown,
  isActive: boolean,
): Promise<void> {
  if (!restComms.getCoreToken()) {
    console.log("[GalleryVideoBugReport] Skipping: no core token")
    return
  }

  const parsed = serializeReactNativeVideoOnError(error)
  const key = galleryVideoIncidentDedupeKey(photo.name, parsed)
  const now = Date.now()
  if (galleryVideoReportDedupeShouldSkip(key, now, GALLERY_VIDEO_REPORT_DEDUPE_MS, reportDedupeRegistry)) {
    console.log("[GalleryVideoBugReport] Skipping duplicate within window:", key)
    return
  }

  const videoUrl = photo.download || photo.url
  const uriScheme = uriSchemeFromPlaybackUrl(videoUrl)

  const actualBehavior = JSON.stringify(
    {
      photoName: photo.name,
      isActive,
      uriScheme,
      videoUriLength: videoUrl.length,
      size: photo.size,
      mime_type: photo.mime_type,
      duration: photo.duration,
      playerError: parsed,
    },
    null,
    2,
  )

  try {
    const submitRes = await submitCategorizedBugIncident({
      categorization: {
        submissionMode: "AUTOMATIC",
        triggerArea: "gallery_video",
        triggerReason: "gallery_video_on_error",
      },
      expectedBehavior: "Video should play in the glasses gallery.",
      actualBehavior,
      severityRating: 5,
    })
    if (!submitRes.ok) {
      console.error("[GalleryVideoBugReport] submitBugIncident failed:", submitRes.error)
    } else {
      console.log("[GalleryVideoBugReport] Incident filed:", submitRes.incidentId)
    }
  } catch (e) {
    console.error("[GalleryVideoBugReport] Unexpected error:", e)
  }
}
