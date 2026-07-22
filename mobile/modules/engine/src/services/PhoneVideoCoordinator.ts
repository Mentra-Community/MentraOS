/**
 * PhoneVideoCoordinator — owns local-miniapp startVideoRecording()/
 * stopVideoRecording() end-to-end.
 *
 * Architecture:
 *   miniapp → SDK → LocalMiniappRuntime → videoRecording runtime hook
 *          → coordinator.startRecording(packageName, opts)
 *            ├── (precheck) glasses connected
 *            └── BluetoothSdk.startVideoRecording(requestId, save, sound, settings)
 *
 * Unlike photo, this has no cloud upload/long-poll; the promise resolves once
 * the glasses report a correlated video_recording_status for the request. The
 * active recordings map enforces single-recording (rejecting overlapping starts
 * so we never hand back a phantom id), validates stop ownership, and lets a
 * closed/crashed miniapp be cleaned up on unregister.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {useGlassesStore} from "../stores/glasses"
import {isGlassesConnected} from "./GlassesReadiness"

export interface VideoRecordingOpts {
  width?: number
  height?: number
  fps?: number
  sound?: boolean
  save?: boolean
}

export interface VideoRecordingStarted {
  recordingId: string
}

export class VideoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "VideoError"
  }
}

interface ActiveRecording {
  packageName: string
  recordingId: string
}

export class PhoneVideoCoordinator {
  // recordingId → active recording. Used to enforce single-recording, validate
  // stop requests, and clean up on miniapp unregister.
  private readonly activeRecordings = new Map<string, ActiveRecording>()

  // Set while a start is dispatching, before it lands in activeRecordings, so a
  // second start that races the first is still rejected.
  private starting = false

  /** Report-safe recording ownership snapshot for incident diagnostics. */
  getDiagnosticSnapshot(): Record<string, unknown> {
    return {
      recordingOwners: [
        ...new Set([...this.activeRecordings.values()].map((recording) => recording.packageName)),
      ].sort(),
      activeRecordingCount: this.activeRecordings.size,
      startInProgress: this.starting,
    }
  }

  async startRecording(packageName: string, opts: VideoRecordingOpts): Promise<VideoRecordingStarted> {
    // Fail fast if glasses aren't connected — the BLE command would otherwise
    // be sent into the void.
    if (!isGlassesConnected(useGlassesStore.getState().connection)) {
      throw new VideoError("GLASSES_NOT_CONNECTED", "Glasses are not connected")
    }

    // The glasses can only record one video at a time. A second start while one
    // is already active (or in-flight) is ignored device-side, but we'd still
    // mint and return a *new* recordingId — and stopping that id would not stop
    // the real recording, leaving it to run until the max-recording timeout.
    // Reject up front so the caller gets an honest error instead of a phantom id.
    if (this.starting || this.activeRecordings.size > 0) {
      throw new VideoError("ALREADY_RECORDING", "A video recording is already in progress")
    }

    this.starting = true
    try {
      const recordingId = `miniapp_video_${Date.now()}_${Math.round(Math.random() * 1e6)}`

      // Only forward settings when at least one field is set; otherwise let the
      // glasses use their saved button-video defaults. The native serializers
      // send each provided field independently, so an fps-only override still
      // applies (the glasses merge the missing fields onto their saved defaults).
      const settings =
        opts.width != null || opts.height != null || opts.fps != null
          ? {width: opts.width, height: opts.height, fps: opts.fps}
          : undefined

      try {
        const status = await BluetoothSdk.startVideoRecording(
          recordingId,
          opts.save ?? false,
          opts.sound ?? true,
          settings,
        )
        if (status.status !== "recording_started") {
          throw new VideoError(
            status.status || "VIDEO_RECORDING_FAILED",
            status.details || "Glasses did not start recording",
          )
        }
      } catch (err) {
        throw this.toVideoError(err, "BLE_SEND_FAILED")
      }

      this.activeRecordings.set(recordingId, {packageName, recordingId})
      return {recordingId}
    } finally {
      this.starting = false
    }
  }

  async stopRecording(
    packageName: string,
    recordingId?: string,
    opts?: {uploadUrl?: string; uploadAuthToken?: string},
  ): Promise<void> {
    if (!recordingId) {
      throw new VideoError("INVALID_RECORDING_ID", "recordingId is required to stop a recording")
    }

    // Validate ownership before touching the glasses: a miniapp may only stop a
    // recording it started, and we shouldn't forward an unknown id.
    const active = this.activeRecordings.get(recordingId)
    if (!active || active.packageName !== packageName) {
      throw new VideoError("RECORDING_NOT_OWNED", "recordingId is not an active recording owned by this app")
    }

    try {
      // When uploadUrl is set the glasses upload the finished clip there (multipart
      // POST); otherwise the recording stays on the glasses (local save).
      const status = await BluetoothSdk.stopVideoRecording(recordingId, opts?.uploadUrl, opts?.uploadAuthToken)
      if (status.status !== "recording_stopped") {
        throw new VideoError(status.status || "VIDEO_STOP_FAILED", status.details || "Glasses did not stop recording")
      }
    } catch (err) {
      const videoError = this.toVideoError(err, "BLE_SEND_FAILED")
      if (this.isAlreadyStopped(videoError)) {
        this.activeRecordings.delete(recordingId)
        return
      }
      // Leave the recording tracked so a retry (or unregister cleanup) can stop
      // it — only drop it once the glasses report a successful stop.
      throw videoError
    }
    this.activeRecordings.delete(recordingId)
  }

  /**
   * Stop every recording owned by a package. Called when a miniapp unregisters
   * (close/crash): the miniapp loses its recordingId, so without this the
   * glasses keep recording until the max-recording timeout or thermal shutdown.
   * Mirrors the streaming coordinator's per-app cleanup on disconnect.
   */
  async stopForApp(packageName: string): Promise<void> {
    const owned = [...this.activeRecordings.values()].filter((r) => r.packageName === packageName)
    for (const rec of owned) {
      try {
        const status = await BluetoothSdk.stopVideoRecording(rec.recordingId)
        // Only drop tracking once the glasses report a successful stop (mirrors
        // stopRecording). If we deleted on failure the glasses could still be
        // recording while the single-recording guard reads "idle", letting the
        // next start hand back a phantom id that can't stop the real recording.
        if (status.status === "recording_stopped") {
          this.activeRecordings.delete(rec.recordingId)
        }
      } catch (err) {
        const videoError = this.toVideoError(err, "BLE_SEND_FAILED")
        if (this.isAlreadyStopped(videoError)) {
          this.activeRecordings.delete(rec.recordingId)
          continue
        }
        console.warn(`[PhoneVideoCoordinator] failed to stop ${rec.recordingId} for ${packageName} on cleanup`, videoError)
      }
    }
  }

  private toVideoError(err: unknown, fallbackCode: string): VideoError {
    if (err instanceof VideoError) return err
    const code = (err as {code?: string})?.code
    const message = err instanceof Error ? err.message : String(err)
    return new VideoError(code || fallbackCode, message)
  }

  private isAlreadyStopped(error: VideoError): boolean {
    return error.code === "not_recording" || error.code === "recording_stopped"
  }
}

// Singleton — coordinator state is process-wide (mirrors phonePhotoCoordinator).
export const phoneVideoCoordinator = new PhoneVideoCoordinator()
