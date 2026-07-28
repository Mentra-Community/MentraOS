/**
 * PhonePhotoCoordinator — owns local-miniapp takePhoto() end-to-end.
 *
 * Local-miniapp photos are BLE-only and never touch the cloud: no presigned
 * upload/read URLs, no runtime publish, no network request anywhere in the
 * flow (OS-1796). The glasses deliver the JPEG to the phone over BLE
 * (`destination: {kind: "phone"}`); the coordinator reads the delivered file
 * and hands the miniapp the image itself as an inline data URL.
 *
 * Architecture:
 *   miniapp → SDK → LocalMiniappRuntime → photo runtime hook
 *          → coordinator.takePhoto(packageName, opts)
 *            ├── (precheck) glasses connected
 *            ├── BluetoothSdk.requestPhoto({destination: {kind: "phone"}, ...})
 *            │     resolves at terminal photo_response success with the local fileUri
 *            ├── read fileUri as base64 → data:image/jpeg;base64,... (file deleted after)
 *            └── race:
 *                  - the native promise (capture + BLE transfer + local write)
 *                  - handlePhotoError(requestId, code, message) rejects if
 *                    MantleManager observes a BLE photo_response error before
 *                    the native promise crosses the bridge
 *
 * `activeRequests` lets MantleManager's gated `photo_response` listener
 * short-circuit the in-flight capture with a typed error (CAMERA_BUSY,
 * BATTERY_LOW, etc.) instead of waiting for the pipeline watchdog.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {PhotoSize, PhotoSuccessResponseEvent, PhotoTransferMethod} from "@mentra/bluetooth-sdk/internal"
import {File} from "expo-file-system"
import {isGlassesConnected} from "./GlassesReadiness"
import {useGlassesStore} from "../stores/glasses"

interface PhotoResult {
  dataUrl: string
  mimeType: string
  size: number
}

/** Map legacy/cloud size names onto the native take_photo enum. */
function normalizePhotoSize(value: unknown): PhotoSize {
  if (typeof value !== "string") return "medium"
  switch (value) {
    case "small":
      return "low"
    case "large":
      return "high"
    case "full":
      return "max"
    default:
      return (["low", "medium", "high", "max"] as const).includes(value as PhotoSize) ? (value as PhotoSize) : "medium"
  }
}

export interface PhotoOpts {
  /** Legacy cloud size names are normalized before the native take_photo command. */
  size?: "low" | "medium" | "high" | "max" | "small" | "large" | "full"
  mode?: "photo" | "text"
  /**
   * @deprecated Local-miniapp photos always ride BLE (`destination: {kind: "phone"}`);
   * the value is validated for shape but otherwise ignored.
   */
  transferMethod?: PhotoTransferMethod
  /**
   * @deprecated Compression only applies to webhook uploads. BLE phone delivery
   * is governed by the transport codec, so this is ignored.
   */
  compress?: "none" | "low" | "medium" | "high"
  sound?: boolean
  /** Keep a copy in the glasses gallery (maps to the phone arm's `keepOnGlasses`). */
  saveToGallery?: boolean
  /** Also export the delivered photo to the phone's OS camera roll. */
  saveToCameraRoll?: boolean
  exposureTimeNs?: number
  iso?: number | null
  aeExposureDivisor?: number
  isoCap?: number
  noiseReduction?: boolean
  edgeEnhancement?: boolean
  /** ZSL preview buffering. */
  zsl?: boolean
  /** MFNR still capture. */
  mfnr?: boolean
  ispDigitalGain?: number
  ispAnalogGain?: string
}

export interface PhotoTaken {
  /** The photo itself, inline: `data:image/jpeg;base64,...`. */
  dataUrl: string
  /**
   * Same data URL as `dataUrl`, so code that renders `photoUrl` (display
   * images, `<img src>`) keeps working. Not fetchable through the background
   * runtime's `fetch` (it is a native HTTP bridge); decode `dataUrl` instead.
   */
  photoUrl: string
  mimeType: string
  size: number
  requestId: string
}

/** Pipeline stage a photo request failed at — surfaced to the miniapp so a dev
 *  sees exactly where it broke, not just a flattened message. */
export type PhotoStage = "command" | "capture" | "deliver"
/** Transport in play at the point of failure. */
export type PhotoTransport = "ble" | "local-file"

export class PhotoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly stage?: PhotoStage,
    public readonly transport?: PhotoTransport,
  ) {
    super(message)
    this.name = "PhotoError"
  }
}

function parsePhotoTransferMethod(value: unknown): PhotoTransferMethod | undefined {
  if (value === undefined) return undefined
  if (value === "auto" || value === "direct" || value === "ble") return value
  throw new PhotoError(
    "INVALID_ARGUMENT",
    `Invalid transferMethod ${JSON.stringify(value)}. Expected "auto", "direct", or "ble".`,
  )
}

interface ActiveRequest {
  packageName: string
  abort: AbortController
  resolve: (r: PhotoResult) => void
  reject: (err: Error) => void
}

/**
 * Last-resort ceiling for the complete capture + encode + BLE transfer +
 * local-read pipeline. The Bluetooth SDK's own terminal deadline for phone
 * delivery is 60 s (PHONE_DELIVERY_REQUEST_TIMEOUT_MS / phoneDeliveryRequestTimeoutMs)
 * and normally rejects first with a typed error; this watchdog sits above it
 * so it only fires if the native promise never settles at all. The miniapp
 * SDK's default takePhoto deadline (PHOTO_REQUEST_TIMEOUT_MS, 90 s) sits above
 * this in turn, so the miniapp sees the typed error rather than ACTION_TIMEOUT.
 */
export const NATIVE_PHONE_DELIVERY_TIMEOUT_MS = 60_000
export const CAPTURE_PIPELINE_TIMEOUT_MS = NATIVE_PHONE_DELIVERY_TIMEOUT_MS + 15_000
export const CAMERA_WARM_UP_DEFAULT_DURATION_MS = 15_000
export const CAMERA_WARM_UP_MAX_DURATION_MS = 60_000

let bleRequestCounter = 0

/** Short 4-hex-char correlation id sent over BLE instead of the full
 *  requestId (wire v2 keeps BLE JSON small). */
function mintBleRequestId(): string {
  bleRequestCounter = (bleRequestCounter + 1) & 0xffff
  return bleRequestCounter.toString(16).padStart(4, "0")
}

/** Phone-minted photo id, mirroring the cloud's `photo_` prefix so logs
 *  and miniapps see one id shape regardless of where the photo came from. */
function mintPhotoRequestId(): string {
  return `photo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export class PhonePhotoCoordinator {
  // requestId → in-flight slot. The gated photo_response listener
  // (DeviceEventRouter) resolves short BLE ids via bleIdToRequest before
  // calling owns() / handlePhotoError().
  private readonly activeRequests = new Map<string, ActiveRequest>()
  /** Short BLE correlation id (4-char hex) → full phone-minted requestId. */
  private readonly bleIdToRequest = new Map<string, string>()
  private readonly activeWarmUps = new Map<
    string,
    {requestId: string; durationMs: number; expiryTimer?: ReturnType<typeof setTimeout>}
  >()

  /** Report-safe camera ownership snapshot for incident diagnostics. */
  getDiagnosticSnapshot(): Record<string, unknown> {
    return {
      captureOwners: [...new Set([...this.activeRequests.values()].map((request) => request.packageName))].sort(),
      warmUpOwners: [...this.activeWarmUps.keys()].sort(),
      activeCaptureCount: this.activeRequests.size,
    }
  }

  async takePhoto(packageName: string, opts: PhotoOpts): Promise<PhotoTaken> {
    // transferMethod is a legacy input: validate its shape (fail fast on
    // garbage) but ignore the value — phone delivery always rides BLE.
    parsePhotoTransferMethod(opts.transferMethod)

    // Pre-check: if glasses aren't even connected, the BLE photo command
    // would be sent into the void and we'd wait for the native deadline or
    // the pipeline watchdog. Fail fast with a typed error.
    //
    // We DON'T pre-check `hasCamera` here — the canonical capability data
    // lives in `getModelCapabilities(deviceModel)` from @mentra/engine and
    // pulling that into this file would add a cross-package import. If a
    // cameraless device receives the BLE photo command, the glasses-side
    // handler will return a photo_response error within ~1s and the gated
    // photo_response listener in MantleManager will short-circuit our
    // pipeline. Slower but correct.
    if (!isGlassesConnected(useGlassesStore.getState().connection)) {
      throw new PhotoError("GLASSES_NOT_CONNECTED", "Glasses are not connected", "command", "ble")
    }

    // Text-mode sensor resolution is owned by ASG constants; the glasses
    // ignore the public size when mode=text.
    const captureSize = opts.size ?? "medium"

    const flowStarted = performance.now()

    // 1) Build the outcome Promise FIRST so both resolve+reject handles
    //    are wired into activeRequests BEFORE any code path can produce
    //    an error. Without this, a fast BLE photo_response (BATTERY_LOW
    //    etc.) racing with the Promise constructor could fire
    //    handlePhotoError() against a no-op rejectFn and silently drop
    //    the error.
    const requestId = mintPhotoRequestId()
    const abort = new AbortController()
    const bleRequestId = mintBleRequestId()
    this.bleIdToRequest.set(bleRequestId, requestId)

    const outcome = new Promise<PhotoResult>((resolve, reject) => {
      this.activeRequests.set(requestId, {packageName, abort, resolve, reject})
    })

    // Last-resort watchdog for a wedged pipeline. The native terminal
    // photo_response normally resolves or rejects first; this only prevents an
    // indefinite hang if that response disappears mid-pipeline.
    const captureWatchdog = setTimeout(() => {
      const e = this.activeRequests.get(requestId)
      if (!e) return
      e.abort.abort()
      e.reject(
        new PhotoError(
          "CAPTURE_TIMEOUT",
          "Photo capture did not complete. The take_photo command, media processing, or BLE transfer may have stalled.",
          "capture",
          "ble",
        ),
      )
    }, CAPTURE_PIPELINE_TIMEOUT_MS)
    // Clear the watchdog on BOTH arms. Not `.finally()`: that would mint a new
    // promise that re-rejects unobserved whenever the photo fails (the caller
    // only awaits `outcome` itself), i.e. an unhandled rejection per failure.
    const clearWatchdog = () => clearTimeout(captureWatchdog)
    void outcome.then(clearWatchdog, clearWatchdog)

    // 2) Drive glasses over BLE. `destination: {kind: "phone"}` forces the BLE
    //    transfer with no webhook anywhere: the native promise resolves at the
    //    terminal photo_response success carrying the delivered fileUri, which
    //    we then read into the inline data URL handed to the miniapp.
    try {
      void BluetoothSdk.requestPhoto({
        requestId: bleRequestId,
        appId: packageName,
        size: normalizePhotoSize(captureSize),
        mode: opts.mode ?? "photo",
        destination: {
          kind: "phone",
          ...(opts.saveToCameraRoll ? {saveToCameraRoll: true} : {}),
          ...(opts.saveToGallery ? {keepOnGlasses: true} : {}),
        },
        sound: opts.sound ?? true,
        exposureTimeNs: opts.exposureTimeNs ?? null,
        iso: opts.iso,
        aeExposureDivisor: opts.aeExposureDivisor,
        isoCap: opts.isoCap,
        noiseReduction: opts.noiseReduction,
        edgeEnhancement: opts.edgeEnhancement,
        ...(opts.zsl != null ? {zsl: opts.zsl} : {}),
        ...(opts.mfnr != null ? {mfnr: opts.mfnr} : {}),
        ispDigitalGain: opts.ispDigitalGain,
        ispAnalogGain: opts.ispAnalogGain,
      })
        .then((event) => this.completePhoneDelivery(requestId, event))
        .catch((err) => {
          const e = this.activeRequests.get(requestId)
          if (!e) return // already settled by handlePhotoError
          e.abort.abort()
          e.reject(this.toPhotoError(err, "PHOTO_FAILED", "capture", "ble"))
        })
    } catch (err) {
      this.activeRequests.delete(requestId)
      this.bleIdToRequest.delete(bleRequestId)
      clearTimeout(captureWatchdog)
      throw this.toPhotoError(err, "BLE_SEND_FAILED", "command", "ble")
    }

    try {
      const result = await outcome
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.debug(
          `[PhonePhotoCoordinator] takePhoto complete ${Math.round(
            performance.now() - flowStarted,
          )}ms requestId=${requestId}`,
        )
      }
      return {
        dataUrl: result.dataUrl,
        photoUrl: result.dataUrl,
        mimeType: result.mimeType,
        size: result.size,
        requestId,
      }
    } finally {
      this.activeRequests.delete(requestId)
      this.bleIdToRequest.delete(bleRequestId)
    }
  }

  /**
   * Terminal success from the Bluetooth SDK: the JPEG is on the phone at
   * `fileUri`. Read it into an inline data URL and resolve the miniapp with it.
   */
  private async completePhoneDelivery(requestId: string, event: PhotoSuccessResponseEvent): Promise<void> {
    if (!this.activeRequests.has(requestId)) return // already settled by handlePhotoError
    try {
      const fileUri = event?.fileUri
      if (!fileUri) {
        throw new PhotoError(
          "PHOTO_DELIVERY_INCOMPLETE",
          "Glasses reported success but the phone delivery carried no fileUri.",
          "capture",
          "ble",
        )
      }
      const mimeType = event.mimeType ?? "image/jpeg"
      const {dataUrl, size} = await this.readDeliveredPhoto(fileUri, mimeType)
      const e = this.activeRequests.get(requestId)
      if (!e) return
      e.resolve({dataUrl, mimeType, size: size ?? event.byteCount ?? -1})
    } catch (err) {
      const e = this.activeRequests.get(requestId)
      if (!e) return
      e.abort.abort()
      e.reject(this.toPhotoError(err, "PHOTO_DELIVERY_FAILED", "deliver", "local-file"))
    }
  }

  /**
   * Read the SDK-delivered JPEG into an inline data URL. The miniapp gets the
   * bytes (OS-1796: no download URL, no cloud in the path), so the delivered
   * file has served its purpose once read and is deleted; the SDK's retention
   * sweep would reclaim it anyway. Camera-roll copies are the user's and are
   * never touched here.
   */
  private async readDeliveredPhoto(fileUri: string, mimeType: string): Promise<{dataUrl: string; size: number | null}> {
    const file = new File(fileUri)
    let base64: string
    let size: number | null
    try {
      base64 = await file.base64()
      size = file.size
    } catch (err) {
      throw new PhotoError(
        "PHOTO_DELIVERY_FAILED",
        `Delivered photo could not be read: ${err instanceof Error ? err.message : String(err)}`,
        "deliver",
        "local-file",
      )
    }
    try {
      file.delete()
    } catch {
      // Best effort: the SDK retention sweep reclaims stragglers.
    }
    return {dataUrl: `data:${mimeType};base64,${base64}`, size}
  }

  /** Map a short BLE requestId from photo_response back to the phone-minted requestId. */
  resolveRequestId(bleOrFullId: string): string {
    return this.bleIdToRequest.get(bleOrFullId) ?? bleOrFullId
  }

  /**
   * Pre-warm the glasses camera so the next takePhoto() is near-instant.
   *
   * Pure BLE — NO upload, NO cloud involvement. The phone mints and owns the
   * requestId, sends the warm-up command, and resolves when the camera reports
   * ready (the native promise resolves on the ready status event).
   */
  async warmUpCamera(
    packageName: string,
    opts: {
      size?: "low" | "medium" | "high" | "max"
      mode?: "photo" | "text"
      exposureTimeNs?: number
      durationMs?: number
      zsl?: boolean
      mfnr?: boolean
    },
  ): Promise<void> {
    // Pre-check: if glasses aren't connected, the BLE warm-up command would be
    // sent into the void. Fail fast with a typed error.
    if (!isGlassesConnected(useGlassesStore.getState().connection)) {
      throw new PhotoError("GLASSES_NOT_CONNECTED", "Glasses are not connected", "command", "ble")
    }

    let lease: {requestId: string; durationMs: number; expiryTimer?: ReturnType<typeof setTimeout>} | undefined
    try {
      await this.stopWarmUpForApp(packageName)
      const requestId = mintBleRequestId()
      const requestedDuration =
        typeof opts.durationMs === "number" && Number.isFinite(opts.durationMs) && opts.durationMs > 0
          ? Math.round(opts.durationMs)
          : CAMERA_WARM_UP_DEFAULT_DURATION_MS
      const durationMs = Math.min(requestedDuration, CAMERA_WARM_UP_MAX_DURATION_MS)
      lease = {requestId, durationMs}
      this.activeWarmUps.set(packageName, lease)
      await BluetoothSdk.warmUpCamera({
        requestId,
        size: normalizePhotoSize(opts.size ?? "medium"),
        mode: opts.mode ?? "photo",
        exposureTimeNs: opts.exposureTimeNs ?? null,
        durationMs,
        ...(opts.zsl != null ? {zsl: opts.zsl} : {}),
        ...(opts.mfnr != null ? {mfnr: opts.mfnr} : {}),
      })
      if (this.activeWarmUps.get(packageName) === lease) {
        lease.expiryTimer = setTimeout(() => {
          if (this.activeWarmUps.get(packageName) === lease) {
            this.activeWarmUps.delete(packageName)
          }
        }, durationMs)
      }
    } catch (err) {
      if (lease && this.activeWarmUps.get(packageName) === lease) {
        if (lease.expiryTimer) clearTimeout(lease.expiryTimer)
        this.activeWarmUps.delete(packageName)
      }
      throw this.toPhotoError(err, "WARM_UP_FAILED", "command", "ble")
    }
  }

  /** Release a miniapp's warm-up even if its original warmUpCamera promise is still opening. */
  async stopWarmUpForApp(packageName: string): Promise<void> {
    const active = this.activeWarmUps.get(packageName)
    if (!active) return
    await BluetoothSdk.stopCameraWarmUp(active.requestId)
    if (this.activeWarmUps.get(packageName) === active) {
      this.activeWarmUps.delete(packageName)
      if (active.expiryTimer) clearTimeout(active.expiryTimer)
    }
  }

  /** True iff this requestId (short BLE id or full id) is one we're currently waiting on. */
  owns(requestId: string): boolean {
    const fullId = this.resolveRequestId(requestId)
    return this.activeRequests.has(fullId)
  }

  /**
   * Called by MantleManager's gated photo_response listener when glasses
   * report an error (BATTERY_LOW, CAMERA_BUSY, etc.) for a phone-owned
   * requestId. Rejects the in-flight takePhoto Promise immediately.
   */
  handlePhotoError(requestId: string, errorCode: string, errorMessage: string): void {
    const fullId = this.resolveRequestId(requestId)
    const entry = this.activeRequests.get(fullId)
    if (!entry) return
    this.bleIdToRequest.delete(requestId)
    // Abort first so a native completion racing in can't double-resolve.
    entry.abort.abort()
    entry.reject(new PhotoError(errorCode || "GLASSES_ERROR", errorMessage || "Glasses error", "capture", "ble"))
  }

  private toPhotoError(err: unknown, fallbackCode: string, stage?: PhotoStage, transport?: PhotoTransport): PhotoError {
    if (err instanceof PhotoError) return err
    const code = (err as {code?: string})?.code
    const message = err instanceof Error ? err.message : String(err)
    return new PhotoError(code || fallbackCode, message, stage, transport)
  }
}

// Singleton — coordinator state is process-wide (mirrors phoneStreamCoordinator).
export const phonePhotoCoordinator = new PhonePhotoCoordinator()
