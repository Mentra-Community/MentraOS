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
 * Unlike photo, this is fire-and-forget: there's no cloud upload/long-poll.
 * `startRecording` resolves once the BLE command has been dispatched, returning
 * the `recordingId` the miniapp passes back to `stopRecording`. The active
 * recordings map lets the host short-circuit a stale stop and (optionally) react
 * to a glasses-reported video error.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk"
import {getRuntimeHooks} from "@mentra/island"

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
  // recordingId → in-flight recording. Used to validate stop requests and to
  // let the host react to glasses-reported video errors.
  private readonly activeRecordings = new Map<string, ActiveRecording>()

  async startRecording(packageName: string, opts: VideoRecordingOpts): Promise<VideoRecordingStarted> {
    // Fail fast if glasses aren't connected — the BLE command would otherwise
    // be sent into the void.
    const glasses = getRuntimeHooks().glassesStatus?.get()
    if (!glasses?.connected) {
      throw new VideoError("GLASSES_NOT_CONNECTED", "Glasses are not connected")
    }

    const recordingId = `miniapp_video_${Date.now()}_${Math.round(Math.random() * 1e6)}`

    // Only forward settings when at least one field is set; otherwise let the
    // glasses use their saved button-video defaults.
    const settings =
      opts.width != null || opts.height != null || opts.fps != null
        ? {width: opts.width, height: opts.height, fps: opts.fps}
        : undefined

    try {
      await BluetoothSdk.startVideoRecording(recordingId, opts.save ?? false, opts.sound ?? true, settings)
    } catch (err) {
      throw this.toVideoError(err, "BLE_SEND_FAILED")
    }

    this.activeRecordings.set(recordingId, {packageName, recordingId})
    return {recordingId}
  }

  async stopRecording(_packageName: string, recordingId?: string): Promise<void> {
    if (!recordingId) {
      throw new VideoError("INVALID_RECORDING_ID", "recordingId is required to stop a recording")
    }

    try {
      await BluetoothSdk.stopVideoRecording(recordingId)
    } catch (err) {
      throw this.toVideoError(err, "BLE_SEND_FAILED")
    } finally {
      this.activeRecordings.delete(recordingId)
    }
  }

  /** True iff this recordingId is one we currently consider active. */
  owns(recordingId: string): boolean {
    return this.activeRecordings.has(recordingId)
  }

  /**
   * Called by MantleManager if the glasses report an error for a phone-owned
   * recording. Drops the active recording so a later stop is a no-op.
   */
  handleVideoError(recordingId: string, _errorCode: string, _errorMessage: string): void {
    this.activeRecordings.delete(recordingId)
  }

  private toVideoError(err: unknown, fallbackCode: string): VideoError {
    if (err instanceof VideoError) return err
    const code = (err as {code?: string})?.code
    const message = err instanceof Error ? err.message : String(err)
    return new VideoError(code || fallbackCode, message)
  }
}

// Singleton — coordinator state is process-wide (mirrors phonePhotoCoordinator).
export const phoneVideoCoordinator = new PhoneVideoCoordinator()
