import type {PhotoInfo} from "@/types/asg"
import {submitAutomaticBugIncident} from "./automaticBugReport"
import {
  GALLERY_VIDEO_REPORT_DEDUPE_MS,
  galleryVideoIncidentDedupeKey,
  serializeReactNativeVideoOnError,
  uriSchemeFromPlaybackUrl,
} from "./galleryVideoPlaybackBugReportCore"

export {
  GALLERY_VIDEO_REPORT_DEDUPE_MS,
  galleryVideoIncidentDedupeKey,
  serializeReactNativeVideoOnError,
} from "./galleryVideoPlaybackBugReportCore"
export type {SerializedVideoPlayerError} from "./galleryVideoPlaybackBugReportCore"

/**
 * Fire-and-forget from gallery Video onError: same incident pipeline as Feedback (severity 5).
 */
export async function submitGalleryVideoPlaybackBugReport(
  photo: PhotoInfo,
  error: unknown,
  isActive: boolean,
): Promise<void> {
  const parsed = serializeReactNativeVideoOnError(error)
  const key = galleryVideoIncidentDedupeKey(photo.name, parsed)

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
    const submitRes = await submitAutomaticBugIncident({
      categorization: {
        submissionMode: "AUTOMATIC",
        triggerArea: "gallery_video",
        triggerReason: "gallery_video_on_error",
      },
      expectedBehavior: "Video should play in the glasses gallery.",
      actualBehavior,
      severityRating: 5,
      dedupeKey: key,
      dedupeWindowMs: GALLERY_VIDEO_REPORT_DEDUPE_MS,
      logTag: "GalleryVideoBugReport",
    })
    if (submitRes.status === "filed") {
      console.log("[GalleryVideoBugReport] Incident filed:", submitRes.incidentId)
    }
  } catch (e) {
    console.error("[GalleryVideoBugReport] Unexpected error:", e)
  }
}
