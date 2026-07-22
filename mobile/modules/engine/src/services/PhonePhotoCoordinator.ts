/**
 * PhonePhotoCoordinator — owns local-miniapp takePhoto() end-to-end.
 *
 * Architecture:
 *   miniapp → SDK → LocalMiniappRuntime → photo runtime hook
 *          → coordinator.takePhoto(packageName, opts)
 *            ├── (precheck) glasses connected + hasCamera
 *            ├── cloudClientService.startManagedPhoto → {requestId, uploadUrl, readUrl}  (cloud-v2 runtime presign)
 *            ├── BluetoothSdk.requestPhoto(requestId, size, uploadUrl, compress, sound)
 *            └── race:
 *                  - cloudClientService.awaitManagedPhotoReady(requestId) resolves on photo.ready push
 *                  - BluetoothSdk.requestPhoto rejects if terminal photo_response is an error
 *                  - handlePhotoError(requestId, code, message) rejects if MantleManager observes
 *                    the same BLE photo_response error before the native promise crosses the bridge
 *
 * `activeRequests` lets MantleManager's gated `photo_response` listener
 * short-circuit our long-poll with a typed error (CAMERA_BUSY, BATTERY_LOW,
 * etc.) instead of waiting 30s for cloud's timeout.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {PhotoSize, PhotoTransferMethod} from "@mentra/bluetooth-sdk/internal"
import {cloudClientService} from "./CloudClientService"
import {isGlassesConnected} from "./GlassesReadiness"
import {useGlassesStore} from "../stores/glasses"

interface PhotoResult {
  photoUrl: string
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
  /** Select direct-only, phone-relayed BLE, or the default Wi-Fi/BLE fallback policy. */
  transferMethod?: PhotoTransferMethod
  compress?: "none" | "low" | "medium" | "high"
  sound?: boolean
  saveToGallery?: boolean
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
  photoUrl: string
  mimeType: string
  size: number
  requestId: string
}

/** Pipeline stage a photo request failed at — surfaced to the miniapp so a dev
 *  sees exactly where it broke, not just a flattened message. */
export type PhotoStage = "presign" | "command" | "capture" | "upload" | "push"
/** Transport in play at the point of failure. */
export type PhotoTransport = "cloud-rest" | "ble" | "wifi" | "ws"

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
 * Last-resort ceiling for the complete capture + encode + transfer + upload
 * pipeline. This must exceed the managed-photo service's 30s ready-push
 * timeout so the cloud can return its more specific failure first.
 *
 * Text mode commonly spends several seconds detecting/cropping the region and
 * can take another 10s+ to transfer over BLE. A 15s ceiling incorrectly
 * rejected successful captures while their upload was still in progress.
 */
export const CAPTURE_PIPELINE_TIMEOUT_MS = 45_000
export const CAMERA_WARM_UP_DEFAULT_DURATION_MS = 15_000
export const CAMERA_WARM_UP_MAX_DURATION_MS = 60_000

let bleRequestCounter = 0

/** Short 4-hex-char correlation id sent over BLE instead of the full cloud
 *  requestId UUID (wire v2 keeps BLE JSON small). */
function mintBleRequestId(): string {
  bleRequestCounter = (bleRequestCounter + 1) & 0xffff
  return bleRequestCounter.toString(16).padStart(4, "0")
}

function toNativeCompression(compress: PhotoOpts["compress"]): "none" | "medium" | "heavy" {
  if (compress === "high") return "heavy"
  if (compress === "low" || compress === "medium") return "medium"
  return "none"
}

export class PhonePhotoCoordinator {
  // Cloud requestId → in-flight slot. The gated photo_response listener
  // (DeviceEventRouter) resolves short BLE ids via bleIdToCloud before calling
  // owns() / handlePhotoError().
  private readonly activeRequests = new Map<string, ActiveRequest>()
  /** Short BLE correlation id (4-char hex) → full cloud requestId. */
  private readonly bleIdToCloud = new Map<string, string>()
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
    const transferMethod = parsePhotoTransferMethod(opts.transferMethod)

    // Pre-check: if glasses aren't even connected, the BLE photo command
    // would be sent into the void and we'd wait 30s for the cloud long-poll
    // to time out. Fail fast with a typed error.
    //
    // We DON'T pre-check `hasCamera` here — the canonical capability data
    // lives in `getModelCapabilities(deviceModel)` from @mentra/types and
    // pulling that into this file would add a cross-package import. If a
    // cameraless device receives the BLE photo command, the glasses-side
    // handler will return a photo_response error within ~1s and the gated
    // photo_response listener in MantleManager will short-circuit our
    // long-poll. Slower but correct.
    if (!isGlassesConnected(useGlassesStore.getState().connection)) {
      throw new PhotoError("GLASSES_NOT_CONNECTED", "Glasses are not connected", "command", "ble")
    }

    // Text-mode sensor resolution is owned by ASG constants; keep cloud metadata on a stable
    // high-capacity tier and let the glasses ignore the public size when mode=text.
    const captureSize = opts.size ?? "medium"

    // 1) Presign via the cloud-v2 managed-photo service. Local miniapps use
    //    ONLY the cloud-v2 path: the runtime presigns upload+read URLs and the
    //    phone (as the device controller) delivers the bytes; the legacy
    //    backend_url mint is gone from this flow.
    let requestId: string
    let uploadUrl: string
    let readUrl: string
    const flowStarted = performance.now()
    try {
      const presignStarted = performance.now()
      const r = await cloudClientService.startManagedPhoto({
        size: opts.mode === "text" ? "max" : captureSize,
      })
      const presignMs = Math.round(performance.now() - presignStarted)
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.debug(
          `[PhonePhotoCoordinator] presign ${presignMs}ms size=${opts.mode === "text" ? "max" : captureSize} mode=${
            opts.mode ?? "photo"
          }`,
        )
      }
      requestId = r.requestId
      uploadUrl = r.uploadUrl
      readUrl = r.readUrl
    } catch (err) {
      throw this.toPhotoError(err, "PHOTO_REQUEST_FAILED", "presign", "cloud-rest")
    }

    // 2) Build the outcome Promise FIRST so both resolve+reject handles
    //    are wired into activeRequests BEFORE any code path can produce
    //    an error. Without this, a fast BLE photo_response (BATTERY_LOW
    //    etc.) racing with the Promise constructor could fire
    //    handlePhotoError() against a no-op rejectFn and silently drop
    //    the error.
    // When the managed-photo upload URL is loopback (the local storage provider
    // reached over `adb reverse`), the glasses cannot reach it over WiFi —
    // localhost on the glasses is the glasses. Force BLE transfer so the phone
    // (which CAN reach the reversed runtime) relays the bytes; a public r2/s3
    // presigned URL stays on "auto".
    const isLoopbackUpload = /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)\b/.test(uploadUrl)

    const abort = new AbortController()
    const bleRequestId = mintBleRequestId()
    this.bleIdToCloud.set(bleRequestId, requestId)

    const outcome = new Promise<PhotoResult>((resolve, reject) => {
      this.activeRequests.set(requestId, {packageName, abort, resolve, reject})
    })

    // Last-resort watchdog for a wedged pipeline. The managed-photo ready push
    // normally resolves or rejects first; this only prevents an indefinite hang
    // if both the native terminal response and cloud push disappear.
    const captureWatchdog = setTimeout(() => {
      const e = this.activeRequests.get(requestId)
      if (!e) return
      e.abort.abort()
      e.reject(
        new PhotoError(
          "CAPTURE_TIMEOUT",
          "Photo capture did not complete. The take_photo command, media processing, transfer, or upload may have stalled.",
          "capture",
          isLoopbackUpload ? "ble" : "wifi",
        ),
      )
    }, CAPTURE_PIPELINE_TIMEOUT_MS)
    // Clear the watchdog on BOTH arms. Not `.finally()`: that would mint a new
    // promise that re-rejects unobserved whenever the photo fails (the caller
    // only awaits `outcome` itself), i.e. an unhandled rejection per failure.
    const clearWatchdog = () => clearTimeout(captureWatchdog)
    void outcome.then(clearWatchdog, clearWatchdog)

    // 3) Drive glasses over BLE. requestPhoto now resolves at terminal
    //    photo_response success, so run it beside the cloud poll instead of
    //    awaiting it before polling. Native defaults transferMethod to "auto"
    //    (Wi-Fi direct with BLE fallback) unless the miniapp forces BLE.
    try {
      void BluetoothSdk.requestPhoto({
        requestId: bleRequestId,
        appId: packageName,
        size: normalizePhotoSize(captureSize),
        mode: opts.mode ?? "photo",
        webhookUrl: uploadUrl,
        authToken: null,
        ...(isLoopbackUpload ? {transferMethod: "ble" as const} : transferMethod ? {transferMethod} : {}),
        compress: toNativeCompression(opts.compress),
        save: opts.saveToGallery ?? false,
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
      }).catch((err) => {
        const e = this.activeRequests.get(requestId)
        if (!e) return
        e.abort.abort()
        e.reject(this.toPhotoError(err, "BLE_SEND_FAILED", "command", "ble"))
      })
    } catch (err) {
      this.activeRequests.delete(requestId)
      this.bleIdToCloud.delete(bleRequestId)
      throw this.toPhotoError(err, "BLE_SEND_FAILED", "command", "ble")
    }

    // 4) Await the runtime's photo.ready push (replaces the legacy long-poll).
    //    handlePhotoError races against it and uses the same entry to reject
    //    first.
    cloudClientService
      .awaitManagedPhotoReady(requestId)
      .then((res) => {
        const e = this.activeRequests.get(requestId)
        if (!e) return // already settled by handlePhotoError
        e.resolve({photoUrl: res.readUrl ?? readUrl, mimeType: "image/jpeg", size: -1})
      })
      .catch((err) => {
        const e = this.activeRequests.get(requestId)
        if (e) e.reject(this.toPhotoError(err, "POLL_FAILED", "push", "ws"))
      })

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
        photoUrl: result.photoUrl,
        mimeType: result.mimeType,
        size: result.size,
        requestId,
      }
    } finally {
      this.activeRequests.delete(requestId)
      this.bleIdToCloud.delete(bleRequestId)
    }
  }

  /** Map a short BLE requestId from photo_response back to the cloud requestId. */
  resolveCloudRequestId(bleOrCloudId: string): string {
    return this.bleIdToCloud.get(bleOrCloudId) ?? bleOrCloudId
  }

  /**
   * Pre-warm the glasses camera so the next takePhoto() is near-instant.
   *
   * Pure BLE — NO cloud presign, NO upload, NO long-poll. The phone mints and owns
   * the requestId, sends the warm-up command, and resolves when the camera reports
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

  /** True iff this requestId (short BLE id or cloud id) is one we're currently waiting on. */
  owns(requestId: string): boolean {
    const cloudId = this.resolveCloudRequestId(requestId)
    return this.activeRequests.has(cloudId)
  }

  /**
   * Called by MantleManager's gated photo_response listener when glasses
   * report an error (BATTERY_LOW, CAMERA_BUSY, etc.) for a phone-owned
   * requestId. Rejects the in-flight takePhoto Promise immediately.
   */
  handlePhotoError(requestId: string, errorCode: string, errorMessage: string): void {
    const cloudId = this.resolveCloudRequestId(requestId)
    const entry = this.activeRequests.get(cloudId)
    if (!entry) return
    this.bleIdToCloud.delete(requestId)
    // Abort the in-flight long-poll first so we don't double-resolve.
    entry.abort.abort()
    entry.reject(new PhotoError(errorCode || "GLASSES_ERROR", errorMessage || "Glasses error", "capture", "ble"))
    // cloud-v2 pending photo requests TTL out on their own; nothing to free.
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
