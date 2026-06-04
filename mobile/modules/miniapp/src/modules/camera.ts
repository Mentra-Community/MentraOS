/**
 * @fileoverview CameraModule — glasses camera control and photo capture.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export type CameraRoiPosition = "center" | "bottom" | "top" | 0 | 1 | 2

export interface SetCameraFovOptions {
  /** Horizontal FOV, degrees. Alias for `fov`. */
  horizontal?: number
  /** Horizontal FOV, degrees. */
  fov?: number
  /** Vertical FOV, degrees. Reserved for future camera firmware. */
  vertical?: number
  /** Crop/region position: center (0), bottom (1), or top (2). */
  roiPosition?: CameraRoiPosition
}

export interface CameraFovResult {
  type: "settings_ack"
  requestId: string
  setting: "camera_fov" | string
  status: string
  ready?: boolean
  timestamp: number
  fov?: number
  roiPosition?: 0 | 1 | 2
  hardwareApplied?: boolean
  errorCode?: string
  errorMessage?: string
}

export interface TakePhotoOptions {
  size?: "small" | "medium" | "large" | "full"
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

export class CameraModule {
  constructor(private readonly session: MiniappSession) {}

  /** True iff `CAMERA` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("CAMERA")
  }

  /**
   * Apply camera FOV/ROI settings on the glasses.
   *
   * Resolves after the ASG client reports that the setting was applied and the
   * camera is ready again. Requires CAMERA permission declared in miniapp.json.
   */
  async setFov(options: SetCameraFovOptions): Promise<CameraFovResult> {
    return this.session.sendRequest<CameraFovResult>({
      type: MiniappRequestType.CAMERA_FOV,
      horizontal: options.horizontal ?? options.fov,
      fov: options.fov,
      vertical: options.vertical,
      roiPosition: options.roiPosition,
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
   * @param recordingId The id returned from `startVideoRecording`.
   */
  async stopVideoRecording(recordingId: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.VIDEO_RECORDING_STOP,
      recordingId,
    })
  }
}
