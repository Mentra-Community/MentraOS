/**
 * @fileoverview CameraModule — glasses camera control and photo capture.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export type CameraRoiPosition = "center" | "bottom" | "top"
export type CameraFovPreset = "narrow" | "standard" | "wide"

export type CameraFovRequest =
  | {
      /** Horizontal FOV, degrees. */
      fov: number
      /** Crop/region position: center, bottom, or top. Defaults to center. */
      roiPosition?: CameraRoiPosition
    }
  | {
      /** Named FOV preset. Presets use center ROI. */
      preset: CameraFovPreset
    }

export type SetCameraFovOptions = CameraFovRequest

export interface CameraFovResult {
  requestId: string
  fov: number
  roiPosition: CameraRoiPosition
  timestamp: number
}

export interface TakePhotoOptions {
  size?: "low" | "medium" | "high" | "max"
  compress?: "none" | "low" | "medium" | "high"
  sound?: boolean
  saveToGallery?: boolean
  /**
   * Manual shutter / exposure time in nanoseconds. Omit (or pass undefined)
   * to let the glasses auto-expose. Honored only on cameras that support
   * manual exposure; ignored otherwise.
   */
  exposureTimeNs?: number
}

export interface PhotoTaken {
  /** Request id that correlates ASG status, upload, and phone/cloud logs. */
  requestId: string
  photoUrl: string
  mimeType: string
  size: number
}

export interface StartVideoRecordingOptions {
  /** Video width in pixels. Omit to use the device's saved button-video default. */
  width?: number
  /** Video height in pixels. Omit to use the device's saved button-video default. */
  height?: number
  /**
   * Frames per second. Lower frame rates keep the glasses cooler and produce
   * smaller files — useful for long recordings where smooth motion isn't needed.
   * Omit to use the device default.
   */
  fps?: number
  /** Play start/stop capture sounds. Defaults to true. */
  sound?: boolean
  /** Keep the recording on the glasses after it finishes. Defaults to false. */
  save?: boolean
}

export interface VideoRecordingStarted {
  /** Identifier for this recording session; pass to {@link stopVideoRecording}. */
  recordingId: string
}

export interface StopVideoRecordingOptions {
  /**
   * Upload the finished recording to this URL with a multipart POST (the file is
   * the `video` part). The glasses upload it directly. Omit to keep the recording
   * on the glasses instead.
   */
  uploadUrl?: string
  /** Bearer token sent as the `Authorization` header on the upload, if your endpoint needs one. */
  uploadAuthToken?: string
}

export class CameraModule {
  constructor(private readonly session: MiniappSession) {}

  /** True iff `CAMERA` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("CAMERA")
  }

  /**
   * Apply camera FOV/ROI settings on the glasses.
   *
   * Resolves after the ASG client reports that the setting was applied to camera
   * hardware after the restart cooldown. Requires CAMERA permission declared in miniapp.json.
   */
  async setFov(request: CameraFovRequest): Promise<CameraFovResult> {
    return this.session.sendRequest<CameraFovResult>({
      type: MiniappRequestType.CAMERA_FOV,
      ...request,
    })
  }

  /**
   * Take a photo via the glasses camera. Returns a URL to the captured image.
   * Requires CAMERA permission declared in miniapp.json.
   *
   * The photo is uploaded to cloud storage; the returned URL is a short-TTL
   * (~30 minute) signed download URL. If the glasses don't have a camera,
   * the phone-side handler rejects with an error. Check
   * `session.capabilities.hasCamera` before calling.
   */
  async takePhoto(options: TakePhotoOptions = {}): Promise<PhotoTaken> {
    return this.session.sendRequest<PhotoTaken>({
      type: MiniappRequestType.PHOTO,
      size: options.size ?? "medium",
      compress: options.compress ?? "none",
      sound: options.sound ?? true,
      saveToGallery: options.saveToGallery ?? false,
      exposureTimeNs: options.exposureTimeNs,
    })
  }

  /**
   * Start recording video on the glasses camera. Returns a `recordingId` to pass
   * to {@link stopVideoRecording} after the glasses report that recording
   * started. Requires CAMERA permission declared in miniapp.json. Check
   * `session.capabilities.hasCamera` before calling.
   *
   * Resolution and frame rate are optional — omit them to use the device's saved
   * button-video settings. Lowering `fps` (e.g. to 5) keeps the glasses cooler
   * during long recordings.
   */
  async startVideoRecording(options: StartVideoRecordingOptions = {}): Promise<VideoRecordingStarted> {
    return this.session.sendRequest<VideoRecordingStarted>({
      type: MiniappRequestType.VIDEO_RECORDING_START,
      width: options.width,
      height: options.height,
      fps: options.fps,
      sound: options.sound ?? true,
      save: options.save ?? false,
    })
  }

  /**
   * Stop an in-progress video recording started with {@link startVideoRecording}.
   *
   * By default the recording stays on the glasses. Pass `uploadUrl` to have the
   * glasses upload the finished clip to your own endpoint.
   *
   * @param recordingId The id returned from `startVideoRecording`.
   * @param options     Optional upload destination for the finished recording.
   */
  async stopVideoRecording(recordingId: string, options: StopVideoRecordingOptions = {}): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.VIDEO_RECORDING_STOP,
      recordingId,
      uploadUrl: options.uploadUrl,
      uploadAuthToken: options.uploadAuthToken,
    })
  }
}
