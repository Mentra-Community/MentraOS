/**
 * @fileoverview CameraModule — glasses camera control and photo capture.
 */

import {parsePhotoCompression, type PhotoCompression} from "@mentra/cloud-protocol/photo-compression"
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

/**
 * A photo's size. `auto` is the largest photo that arrives in about 2 seconds on the link it is
 * sent over, which the glasses decide when they send it: 1280x960 over Bluetooth, the full sensor
 * over the glasses Wi-Fi link. `low`, `medium`, `high` and `max` are the same on every link.
 * Glasses from before `auto` take it as `medium`.
 */
export type PhotoSize = "auto" | "low" | "medium" | "high" | "max"

export interface TakePhotoOptions {
  /** Default `auto` (`medium` for {@link CameraModule.takeCloudPhoto}). */
  size?: PhotoSize
  /** Capture at maximum source quality and optimize BLE delivery for readable text. */
  mode?: "photo" | "text"
  compress?: PhotoCompression
  sound?: boolean
  saveToGallery?: boolean
  /**
   * Manual shutter / exposure time in nanoseconds. Omit (or pass undefined)
   * to let the glasses auto-expose. Honored only on cameras that support
   * manual exposure; ignored otherwise.
   */
  exposureTimeNs?: number
  /** Sensor ISO for this capture only. Only used when `exposureTimeNs` enables manual exposure. */
  iso?: number | null
  /** After AE convergence, divide the metered exposure by this factor (scan mode). */
  aeExposureDivisor?: number
  /** Cap ISO after AE metering (scan mode). */
  isoCap?: number
  /** Request per-capture noise reduction. Sent on the wire; glasses may log `not_implemented`. */
  noiseReduction?: boolean
  /** Request per-capture edge enhancement. Sent on the wire; glasses may log `not_implemented`. */
  edgeEnhancement?: boolean
  /**
   * ZSL buffering. Manual and scan stills force it off because fixed sensor controls take priority.
   */
  zsl?: boolean
  /**
   * MFNR still capture. Manual and scan stills force it off because fixed sensor controls take priority.
   */
  mfnr?: boolean
  /** ISP digital gain hint. */
  ispDigitalGain?: number
  /** ISP analog gain hint. */
  ispAnalogGain?: string
  /**
   * Override the SDK's default 60s request timeout for this capture only.
   * Leave unset for a normal user-triggered capture (the full 60s ceiling is
   * appropriate there). Callers that speculatively fire a capture and may
   * abandon it if the result isn't needed (e.g. a short-lived non-visual
   * assistant turn racing a capture against a ~1s latency cap) should pass a
   * short value here so the abandoned `takePhoto()` promise settles quickly
   * instead of sitting on the default 60s ceiling.
   */
  timeoutMs?: number
}

/**
 * A photo from the glasses, kept on the phone as one of the miniapp's own files. Nothing is uploaded:
 * the miniapp decides where the photo goes.
 */
export interface PhotoTaken {
  /** Request id that correlates glasses status and phone logs. */
  requestId: string
  /**
   * The photo's key in `session.blob`. Read it with `session.blob.bytes(key)`, for example to send to a
   * backend with `fetch`. The photo is deleted at `expiresAt`; to keep it, store a copy under a key of
   * your own (`session.blob.set(myKey, bytes)`).
   */
  key: string
  /**
   * A URL the miniapp's own screen can load, for example `<img src={url}>`: pass it to the UI as it is.
   * It works only in this miniapp's screen, and only until the photo is deleted. Absent for a miniapp
   * with no screen.
   */
  url?: string
  mimeType: string
  /** The photo's size in bytes. */
  size: number
  /** When the phone deletes the photo, as a Unix time in milliseconds: 30 minutes after capture. */
  expiresAt: number
  /**
   * A small copy of the photo, made on the phone: a JPEG at most 512 px on its long side, upright,
   * about 20 to 40 KB. Show it in lists and timelines instead of the full photo, which a screen
   * decodes to tens of megabytes. It is deleted with the photo; absent if the photo couldn't be read.
   */
  thumbnail?: PhotoThumbnail
}

/**
 * A photo's thumbnail ({@link PhotoTaken.thumbnail}): one of the miniapp's own files like the photo,
 * read with `session.blob` under `key` and shown on the screen from `url`, until the photo is deleted.
 * Unlike {@link PhotoPreview}, it exists once the full photo is on the phone.
 */
export interface PhotoThumbnail {
  /** The thumbnail's key in `session.blob`. To keep it past the photo, store a copy under a key of your own. */
  key: string
  /** A URL the miniapp's own screen can load, as {@link PhotoTaken.url}. Absent for a miniapp with no screen. */
  url?: string
  width: number
  height: number
  mimeType: string
}

/** A photo's preview: the glasses' at most 500 px JPEG, as a `data:image/jpeg;base64,` URL. */
export interface PhotoPreview {
  url: string
  width?: number
  height?: number
}

/**
 * One photo, in stages ({@link CameraModule.capture}). Any number can be in flight: a capture is
 * refused (`CAMERA_BUSY`) only while another one is being taken, never because photos are being sent.
 */
export interface PhotoCapture {
  readonly photoId: string
  /** Resolves once the glasses took the photo: the camera is free for the next one. */
  readonly captured: Promise<void>
  /**
   * The full photo, kept on the phone as {@link CameraModule.takePhoto}'s is. The first call asks
   * the glasses to send it; until then it waits on the glasses (deferred delivery), for 30 minutes
   * at most. Later calls return the same photo.
   */
  photo(): Promise<PhotoTaken>
  /** The full photo isn't needed: the glasses delete it. Stages not reached yet reject. */
  release(): Promise<void>
}

/** A capture asked for with `preview: true` ({@link CaptureOptions.preview}). */
export interface PhotoCaptureWithPreview extends PhotoCapture {
  /**
   * A small preview (at most 500 px), which comes over Bluetooth before the full photo. For a
   * preview only, await it and then `release()` without calling `photo()`.
   */
  readonly preview: Promise<PhotoPreview>
}

/** The options of a photo in stages ({@link CameraModule.capture}). */
export interface CaptureOptions extends TakePhotoOptions {
  /**
   * The glasses send a small preview right after the capture: `capture.preview`. Without it they
   * send none and the capture has no `preview`, which leaves Bluetooth to the full photos.
   */
  preview?: boolean
}

/** A camera session's continuous trigger ({@link CameraSession.continuous}). */
export interface ContinuousCapture<C extends PhotoCapture = PhotoCapture> {
  /** Each photo it takes on its own; release it when done. */
  onPhoto(handler: (capture: C) => void): () => void
  /** Stop taking photos on their own. The session stays open: its link, camera and photos stay. */
  stop(): Promise<void>
}

/**
 * The glasses camera, opened for a stretch of work ({@link CameraModule.open}). From open to
 * {@link close} the Mentra App holds the glasses Wi-Fi link, so full photos come over it, and
 * keeps the camera warm, so each photo is taken at once. Every photo goes through the session the
 * same way, one at a time; its photos have a preview when the session asked for one.
 */
export interface CameraSession<C extends PhotoCapture = PhotoCapture> {
  /** One photo (a tap), with these options over the session's, taken in the session's turn; resolves once started. */
  capture(options?: TakePhotoOptions): Promise<C>
  /**
   * Photos back to back on their own, as fast as the camera takes them, with these options over
   * the session's, until `stop()` or the session closes. It waits by itself while the link is down,
   * so photos never pile up on the glasses. Starting another stops this one.
   */
  continuous(options?: TakePhotoOptions): ContinuousCapture<C>
  /** Stop taking photos at once; resolves once the photos the session handed out are released and the link given back. */
  close(): Promise<void>
}

/** What {@link CameraModule.takeCloudPhoto} resolves to: a photo uploaded to Mentra's cloud. */
export interface CloudPhotoTaken {
  /** Request id that correlates glasses status, upload, and phone/cloud logs. */
  requestId: string
  /** A short-lived (~30 minute) signed download URL. */
  photoUrl: string
  mimeType: string
  size: number
}

export interface TakeCloudPhotoOptions extends TakePhotoOptions {
  /**
   * Image delivery path. `auto` tries direct Wi-Fi upload from the glasses and falls back to
   * BLE; `direct` disables BLE fallback; `ble` always relays through the phone.
   */
  transferMethod?: "auto" | "direct" | "ble"
}

export interface WarmUpCameraOptions {
  /** Default `auto`, as a photo's. */
  size?: PhotoSize
  /** Match the upcoming capture mode so warm-up and capture share one ASG camera session. */
  mode?: "photo" | "text"
  exposureTimeNs?: number
  /** ZSL preview buffering for the warm-up session. */
  zsl?: boolean
  /** MFNR still capture for the warm-up session. */
  mfnr?: boolean
}

/** A warm camera, held until {@link CameraWarmUp.release} or the miniapp closes ({@link CameraModule.warmUp}). */
export interface CameraWarmUp {
  /** Idempotent. The glasses close the camera once nothing needs it. */
  release(): Promise<void>
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

/** Only the options a photo of a camera session sets itself: the session's own fill the rest. */
function photoOverrides(options: TakePhotoOptions): Record<string, unknown> {
  const overrides: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || key === "timeoutMs" || key === "preview") continue
    overrides[key] = key === "compress" ? parsePhotoCompression(value as TakePhotoOptions["compress"]) : value
  }
  return overrides
}

/** A stage the caller may never await is not an unhandled rejection. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined)
  return promise
}

export class CameraModule {
  constructor(private readonly session: MiniappSession) {}

  /** True iff `CAMERA` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("CAMERA")
  }

  /**
   * Apply a session-owned camera FOV/ROI override on the glasses.
   *
   * Resolves after the ASG client reports that the setting was applied to camera
   * hardware after the restart cooldown. The host restores the prior override or persistent base
   * when this miniapp closes. Requires CAMERA permission declared in miniapp.json.
   */
  async setFov(request: CameraFovRequest): Promise<CameraFovResult> {
    return this.session.sendRequest<CameraFovResult>({
      type: MiniappRequestType.CAMERA_FOV,
      ...request,
    })
  }

  /**
   * Take a photo with the glasses camera. Requires CAMERA permission declared in miniapp.json.
   *
   * The same as `capture(options).photo()`, releasing the glasses' copy once the photo is here. The
   * photo comes to the phone (over the glasses Wi-Fi link when it is up, else Bluetooth) and stays
   * there as one of the miniapp's own files: no internet connection is needed and nothing is uploaded. Read it with
   * `session.blob.bytes(photo.key)`, show it in the miniapp's screen from `photo.url`, and send it
   * wherever the miniapp needs it. The phone deletes it after 30 minutes.
   *
   * If the glasses don't have a camera, the phone-side handler rejects with an error. Check
   * `session.capabilities.hasCamera` before calling.
   */
  async takePhoto(options: TakePhotoOptions = {}): Promise<PhotoTaken> {
    // One request, which every Mentra App with local photos answers; a current one serves it as
    // capture(options).photo() and then releases the glasses' copy.
    const photo = await this.session.sendRequest<PhotoTaken>(
      {...this.photoRequest(options, "auto"), delivery: "local"},
      options.timeoutMs != null ? {timeoutMs: options.timeoutMs} : undefined,
    )
    // A Mentra App from before local photos answers with a cloud URL and no key. A miniapp built with this
    // SDK declares the first version that has them as its minHostVersion, so this is a development build
    // that is behind.
    if (typeof photo?.key !== "string" || !photo.key) {
      throw new Error("This Mentra App can't keep photos on the phone yet. Update the Mentra App.")
    }
    return photo
  }

  /**
   * Take a photo in stages: `captured` when the camera is free again, `photo()` for its full size,
   * which stays on the glasses until first asked for, and `release()` when it isn't needed. With
   * `preview: true` the glasses also send a small preview, `capture.preview`, before the full photo;
   * without it there is none. Requires CAMERA permission declared in miniapp.json. Use it to take
   * photos back to back and fetch only the ones you keep. Needs a Mentra App with photo captures
   * (a newer one than `takePhoto` needs).
   */
  capture(options: CaptureOptions & {preview: true}): PhotoCaptureWithPreview
  capture(options?: CaptureOptions): PhotoCapture
  capture(options: CaptureOptions = {}): PhotoCapture {
    const photoId = mintPhotoId()
    const timeout = options.timeoutMs != null ? {timeoutMs: options.timeoutMs} : undefined
    const started = quiet(this.session.sendRequest<void>({...this.photoRequest(options, "auto"), type: MiniappRequestType.PHOTO_CAPTURE, photoId}, timeout))
    return this.captureOf(photoId, started, options.preview === true, timeout)
  }

  /**
   * Open the camera for a stretch of work (documenting a site, a walk-through). From open to
   * `close()` the Mentra App holds the glasses Wi-Fi link, so full photos come over it, and keeps
   * the camera warm with these settings, so each photo is taken at once. `camera.capture(options)`
   * takes one photo (a tap); `camera.continuous()` takes them back to back. Both are
   * captures like {@link capture}'s, through the same session; release each when done.
   * `preview: true` gives every photo a preview. The miniapp closing closes it. Requires CAMERA
   * permission.
   */
  open(options: CaptureOptions & {preview: true}): CameraSession<PhotoCaptureWithPreview>
  open(options?: CaptureOptions): CameraSession
  open(options: CaptureOptions = {}): CameraSession {
    const preview = options.preview === true
    const cameraId = mintPhotoId()
    const timeout = options.timeoutMs != null ? {timeoutMs: options.timeoutMs} : undefined
    const opened = quiet(
      this.session.sendRequest<void>({...this.photoRequest(options, "auto"), type: MiniappRequestType.CAMERA_OPEN, cameraId}),
    )
    let closing: Promise<void> | undefined
    /** The current trigger's subscriptions: the host stops a trigger when another starts or the session closes. */
    let silenceTrigger = () => {}
    return {
      capture: async (extra: TakePhotoOptions = {}) => {
        await opened
        const photoId = mintPhotoId()
        // The session takes it in its turn, after the photo the camera is taking now.
        const taken = quiet(
          this.session.sendRequest<void>(
            {...photoOverrides(extra), type: MiniappRequestType.CAMERA_SESSION_CAPTURE, cameraId, photoId},
            {timeoutMs: 60_000},
          ),
        )
        await taken
        return this.captureOf(photoId, taken, preview, timeout)
      },
      continuous: (photoOptions: TakePhotoOptions = {}) => {
        const runId = mintPhotoId()
        const photoHandlers = new Set<(capture: PhotoCapture) => void>()
        const offPhoto = this.session.on("continuousPhoto", (event) => {
          if (event.runId !== runId) return
          const capture = this.captureOf(event.photoId, Promise.resolve(), preview, timeout)
          for (const handler of photoHandlers) handler(capture)
        })
        silenceTrigger()
        silenceTrigger = offPhoto
        const started = quiet(
          opened.then(() =>
            this.session.sendRequest<void>({
              ...photoOverrides(photoOptions),
              type: MiniappRequestType.CAMERA_CONTINUOUS_START,
              cameraId,
              runId,
            }),
          ),
        )
        let stopped: Promise<void> | undefined
        return {
          onPhoto(handler) {
            photoHandlers.add(handler)
            return () => {
              photoHandlers.delete(handler)
            }
          },
          stop: () => {
            if (stopped) return stopped
            offPhoto()
            stopped = started
              .catch(() => undefined)
              .then(() => this.session.sendRequest<void>({type: MiniappRequestType.CAMERA_CONTINUOUS_STOP, cameraId, runId}))
            return stopped
          },
        }
      },
      close: () => {
        if (closing) return closing
        silenceTrigger()
        // The host answers once the session's photos are released, which can take a while on Bluetooth.
        closing = opened
          .catch(() => undefined)
          .then(() => this.session.sendRequest<void>({type: MiniappRequestType.CAMERA_CLOSE, cameraId}, {timeoutMs: 180_000}))
        return closing
      },
    }
  }

  /** A capture's stages over the host's photo requests, once `started` says it exists there. */
  private captureOf(photoId: string, started: Promise<void>, withPreview: boolean, timeout?: {timeoutMs: number}): PhotoCapture {
    const stage = <T>(name: "captured" | "preview" | "photo") =>
      quiet(started.then(() => this.session.sendRequest<T>({type: MiniappRequestType.PHOTO_CAPTURE_STAGE, photoId, stage: name}, timeout)))
    // Each stage is asked for when first awaited, once.
    let captured: Promise<void> | undefined
    let preview: Promise<PhotoPreview> | undefined
    let photo: Promise<PhotoTaken> | undefined
    const capture: PhotoCapture = {
      photoId,
      get captured() {
        return (captured ??= stage<void>("captured"))
      },
      photo: () => (photo ??= stage<PhotoTaken>("photo")),
      release: () => started.then(() => this.session.sendRequest<void>({type: MiniappRequestType.PHOTO_RELEASE, photoId})),
    }
    // Without `preview: true` the glasses send none, and the capture has no preview.
    if (!withPreview) return capture
    return Object.defineProperty(capture, "preview", {
      enumerable: true,
      get: () => (preview ??= stage<PhotoPreview>("preview")),
    }) as PhotoCaptureWithPreview
  }


  /**
   * Take a photo and upload it to Mentra's cloud, resolving to a short-lived signed URL.
   *
   * @deprecated Use {@link takePhoto}, which keeps the photo on the phone. This remains for one
   * case: a full-size photo that must reach a server quickly. The glasses can upload it over their
   * own Wi-Fi, which is much faster than sending it to the phone over Bluetooth. It needs an
   * internet connection, and it goes away once the glasses can send large photos to the phone.
   */
  async takeCloudPhoto(options: TakeCloudPhotoOptions = {}): Promise<CloudPhotoTaken> {
    return this.session.sendRequest<CloudPhotoTaken>(
      {
        ...this.photoRequest(options, "medium"),
        ...(options.transferMethod !== undefined ? {transferMethod: options.transferMethod} : {}),
      },
      options.timeoutMs != null ? {timeoutMs: options.timeoutMs} : undefined,
    )
  }

  /** The capture settings of a photo request, shared by both delivery paths. */
  private photoRequest(options: CaptureOptions, size: PhotoSize) {
    return {
      ...(options.preview === true ? {preview: true} : {}),
      type: MiniappRequestType.PHOTO,
      size: options.size ?? size,
      mode: options.mode ?? "photo",
      compress: parsePhotoCompression(options.compress),
      sound: options.sound ?? true,
      saveToGallery: options.saveToGallery ?? false,
      exposureTimeNs: options.exposureTimeNs,
      iso: options.iso,
      aeExposureDivisor: options.aeExposureDivisor,
      isoCap: options.isoCap,
      noiseReduction: options.noiseReduction,
      edgeEnhancement: options.edgeEnhancement,
      zsl: options.zsl,
      mfnr: options.mfnr,
      ispDigitalGain: options.ispDigitalGain,
      ispAnalogGain: options.ispAnalogGain,
    }
  }

  /**
   * Keep the glasses camera warm until `release()` or the miniapp closes, so each photo taken with the same `size`,
   * `mode`, `exposureTimeNs`, `zsl` and `mfnr` is taken at once, however long that is: the phone re-arms the glasses'
   * warm-up as needed. Resolves once the camera is warm. A miniapp holds one warm-up: a new one replaces it.
   * Requires CAMERA permission in miniapp.json.
   *
   * Rejects with `camera_busy` while a photo is being captured or another warm-up is opening: retry shortly, or just
   * take the photo (it works regardless, only slower).
   */
  async warmUp(options: WarmUpCameraOptions = {}): Promise<CameraWarmUp> {
    const warmUpId = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    await this.session.sendRequest<void>({
      type: MiniappRequestType.CAMERA_WARM_UP,
      hold: true,
      warmUpId,
      size: options.size ?? "auto",
      mode: options.mode ?? "photo",
      exposureTimeNs: options.exposureTimeNs,
      zsl: options.zsl,
      mfnr: options.mfnr,
    })
    let released: Promise<void> | undefined
    return {
      release: () =>
        (released ??= this.session.sendRequest<void>({type: MiniappRequestType.CAMERA_WARM_UP_RELEASE, warmUpId})),
    }
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

function mintPhotoId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
