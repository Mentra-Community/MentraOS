/**
 * PhonePhotoCoordinator — owns local-miniapp takePhoto() end-to-end.
 *
 * Architecture:
 *   miniapp → SDK → LocalMiniappRuntime → photo runtime hook
 *          → coordinator.takePhoto(packageName, opts)
 *            ├── (precheck) glasses connected + hasCamera
 *            ├── cloudClient.startManagedPhoto → {requestId, uploadUrl, readUrl}  (cloud-v2 runtime presign)
 *            ├── BluetoothSdk.requestPhoto(requestId, packageName, size, uploadUrl, compress, sound)
 *            └── race:
 *                  - cloudClient.awaitManagedPhotoReady(requestId) resolves on photo.ready push
 *                  - BluetoothSdk.requestPhoto rejects if terminal photo_response is an error
 *                  - handlePhotoError(requestId, code, message) rejects if MantleManager observes
 *                    the same BLE photo_response error before the native promise crosses the bridge
 *
 * `activeRequests` lets MantleManager's gated `photo_response` listener
 * short-circuit our long-poll with a typed error (CAMERA_BUSY, BATTERY_LOW,
 * etc.) instead of waiting 30s for cloud's timeout.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk"
import {getRuntimeHooks} from "@mentra/island"

import {normalizePhotoSize} from "@/services/SocketComms.normalizers"
import {cloudClient} from "@/services/cloudClient"
import {freePhoto, pollUntilReady, requestPhoto, type PhotoResult} from "./v2PhotoApi"

export interface PhotoOpts {
  /** Legacy cloud size names are normalized before the native take_photo command. */
  size?: "low" | "medium" | "high" | "max" | "small" | "large" | "full"
  compress?: "none" | "low" | "medium" | "high"
  sound?: boolean
  saveToGallery?: boolean
  exposureTimeNs?: number
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

interface ActiveRequest {
  packageName: string
  abort: AbortController
  resolve: (r: PhotoResult) => void
  reject: (err: Error) => void
}

/** How long to wait for the glasses to acknowledge a capture before failing
 *  fast with CAPTURE_TIMEOUT, instead of hanging on the cloud push timeout. */
const CAPTURE_TIMEOUT_MS = 15_000

function toNativeCompression(compress: PhotoOpts["compress"]): "none" | "medium" | "heavy" {
  if (compress === "high") return "heavy"
  if (compress === "low" || compress === "medium") return "medium"
  return "none"
}

export class PhonePhotoCoordinator {
  // requestId → in-flight slot. Used by MantleManager's gated photo_response
  // listener to find the slot a glasses-side error belongs to.
  private readonly activeRequests = new Map<string, ActiveRequest>()

  async takePhoto(packageName: string, opts: PhotoOpts): Promise<PhotoTaken> {
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
    const glasses = getRuntimeHooks().glassesStatus?.get()
    if (!glasses?.connected) {
      throw new PhotoError("GLASSES_NOT_CONNECTED", "Glasses are not connected", "command", "ble")
    }

    // 1) Presign via the cloud-v2 managed-photo service. Local miniapps use
    //    ONLY the cloud-v2 path: the runtime presigns upload+read URLs and the
    //    phone (as the device controller) delivers the bytes; the legacy
    //    backend_url mint is gone from this flow.
    let requestId: string
    let uploadUrl: string
    let readUrl: string
    try {
      const r = await cloudClient.startManagedPhoto({size: opts.size ?? "medium"})
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
    const outcome = new Promise<PhotoResult>((resolve, reject) => {
      this.activeRequests.set(requestId, {packageName, abort, resolve, reject})
    })

    // Capture watchdog: if the glasses never acknowledge the command (no camera
    // sound, no capture, no upload — e.g. the command was dropped, or WiFi
    // upload to an unreachable host stalled), fail FAST and specifically rather
    // than waiting on the cloud push to time out. A dev should see
    // "CAPTURE_TIMEOUT stage:capture via:ble" within seconds, not a silent hang.
    const captureWatchdog = setTimeout(() => {
      const e = this.activeRequests.get(requestId)
      if (!e) return
      e.abort.abort()
      e.reject(
        new PhotoError(
          "CAPTURE_TIMEOUT",
          "Glasses never acknowledged the capture (no photo_response). The take_photo command may not have reached the device, or the upload target was unreachable.",
          "capture",
          isLoopbackUpload ? "ble" : "wifi",
        ),
      )
    }, CAPTURE_TIMEOUT_MS)
    void outcome.finally(() => clearTimeout(captureWatchdog))

    // 3) Drive glasses over BLE. requestPhoto now resolves at terminal
    //    photo_response success, so run it beside the cloud poll instead of
    //    awaiting it before polling. iOS auto-injects transferMethod: "auto"
    //    (WiFi direct with BLE fallback) — see MentraLive.swift.
    try {
      void BluetoothSdk.requestPhoto({
        requestId,
        appId: packageName,
        size: normalizePhotoSize(opts.size ?? "medium"),
        webhookUrl: uploadUrl,
        authToken: null,
        ...(isLoopbackUpload ? {transferMethod: "ble" as const} : {}),
        compress: toNativeCompression(opts.compress),
        save: opts.saveToGallery ?? false,
        sound: opts.sound ?? true,
        exposureTimeNs: opts.exposureTimeNs ?? null,
      }).catch((err) => {
        const e = this.activeRequests.get(requestId)
        if (!e) return
        e.abort.abort()
        e.reject(this.toPhotoError(err, "BLE_SEND_FAILED", "command", "ble"))
      })
    } catch (err) {
      this.activeRequests.delete(requestId)
      throw this.toPhotoError(err, "BLE_SEND_FAILED", "command", "ble")
    }

    // 4) Await the runtime's photo.ready push (replaces the legacy long-poll).
    //    handlePhotoError races against it and uses the same entry to reject
    //    first.
    cloudClient
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
      return {
        photoUrl: result.photoUrl,
        mimeType: result.mimeType,
        size: result.size,
        requestId,
      }
    } finally {
      this.activeRequests.delete(requestId)
    }
  }

  /**
   * Pre-warm the glasses camera so the next takePhoto() is near-instant.
   *
   * Pure BLE — NO cloud presign, NO upload, NO long-poll. We mint a local
   * requestId, send the warm-up command, and resolve when the camera reports
   * ready (the native promise resolves on the ready status event).
   */
  async warmUpCamera(
    packageName: string,
    opts: {size?: "low" | "medium" | "high" | "max"; exposureTimeNs?: number; durationMs?: number},
  ): Promise<void> {
    // Pre-check: if glasses aren't connected, the BLE warm-up command would be
    // sent into the void. Fail fast with a typed error.
    const glasses = getRuntimeHooks().glassesStatus?.get()
    if (!glasses?.connected) {
      throw new PhotoError("GLASSES_NOT_CONNECTED", "Glasses are not connected", "command", "ble")
    }

    // No cloud presign on the warm-up path — mint a local requestId.
    const requestId = `warm_${Date.now()}_${Math.round(Math.random() * 1e6)}`

    try {
      await BluetoothSdk.warmUpCamera({
        requestId,
        appId: packageName,
        size: normalizePhotoSize(opts.size ?? "medium"),
        exposureTimeNs: opts.exposureTimeNs ?? null,
        durationMs: opts.durationMs ?? 15000,
      })
    } catch (err) {
      throw this.toPhotoError(err, "WARM_UP_FAILED", "command", "ble")
    }
  }

  /** True iff this requestId is one we're currently waiting on. */
  owns(requestId: string): boolean {
    return this.activeRequests.has(requestId)
  }

  /**
   * Called by MantleManager's gated photo_response listener when glasses
   * report an error (BATTERY_LOW, CAMERA_BUSY, etc.) for a phone-owned
   * requestId. Rejects the in-flight takePhoto Promise immediately.
   */
  handlePhotoError(requestId: string, errorCode: string, errorMessage: string): void {
    const entry = this.activeRequests.get(requestId)
    if (!entry) return
    // Abort the in-flight long-poll first so we don't double-resolve.
    entry.abort.abort()
    entry.reject(new PhotoError(errorCode || "GLASSES_ERROR", errorMessage || "Glasses error", "capture", "ble"))
    // cloud-v2 pending photo requests TTL out on their own; nothing to free.
  }

  private toPhotoError(
    err: unknown,
    fallbackCode: string,
    stage?: PhotoStage,
    transport?: PhotoTransport,
  ): PhotoError {
    if (err instanceof PhotoError) return err
    const code = (err as {code?: string})?.code
    const message = err instanceof Error ? err.message : String(err)
    return new PhotoError(code || fallbackCode, message, stage, transport)
  }
}

// Singleton — coordinator state is process-wide (mirrors phoneStreamCoordinator).
export const phonePhotoCoordinator = new PhonePhotoCoordinator()
