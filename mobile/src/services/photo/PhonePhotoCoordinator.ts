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

import {cloudClient} from "@/services/cloudClient"
import {type PhotoResult} from "./v2PhotoApi"

export interface PhotoOpts {
  size?: "small" | "medium" | "large" | "full"
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

export class PhotoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
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
      throw new PhotoError("GLASSES_NOT_CONNECTED", "Glasses are not connected")
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
      throw this.toPhotoError(err, "PHOTO_REQUEST_FAILED")
    }

    // 2) Build the outcome Promise FIRST so both resolve+reject handles
    //    are wired into activeRequests BEFORE any code path can produce
    //    an error. Without this, a fast BLE photo_response (BATTERY_LOW
    //    etc.) racing with the Promise constructor could fire
    //    handlePhotoError() against a no-op rejectFn and silently drop
    //    the error.
    const abort = new AbortController()
    const outcome = new Promise<PhotoResult>((resolve, reject) => {
      this.activeRequests.set(requestId, {packageName, abort, resolve, reject})
    })

    // 3) Drive glasses over BLE. requestPhoto now resolves at terminal
    //    photo_response success, so run it beside the cloud poll instead of
    //    awaiting it before polling. iOS auto-injects transferMethod: "auto"
    //    (WiFi direct with BLE fallback) — see MentraLive.swift.
    // When the managed-photo upload URL is loopback (the local storage provider
    // reached over `adb reverse`), the glasses cannot reach it over WiFi —
    // localhost on the glasses is the glasses. Force BLE transfer so the phone
    // (which CAN reach the reversed runtime) relays the bytes. A normal
    // presigned r2/s3 URL is publicly reachable, so leave transfer on "auto".
    const isLoopbackUpload = /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)\b/.test(uploadUrl)
    try {
      void BluetoothSdk.requestPhoto({
        requestId,
        appId: packageName,
        size: opts.size ?? "medium",
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
        e.reject(this.toPhotoError(err, "BLE_SEND_FAILED"))
      })
    } catch (err) {
      this.activeRequests.delete(requestId)
      throw this.toPhotoError(err, "BLE_SEND_FAILED")
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
        if (e) e.reject(this.toPhotoError(err, "POLL_FAILED"))
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
    entry.reject(new PhotoError(errorCode || "GLASSES_ERROR", errorMessage || "Glasses error"))
    // cloud-v2 pending photo requests TTL out on their own; nothing to free.
  }

  private toPhotoError(err: unknown, fallbackCode: string): PhotoError {
    if (err instanceof PhotoError) return err
    const code = (err as {code?: string})?.code
    const message = err instanceof Error ? err.message : String(err)
    return new PhotoError(code || fallbackCode, message)
  }
}

// Singleton — coordinator state is process-wide (mirrors phoneStreamCoordinator).
export const phonePhotoCoordinator = new PhonePhotoCoordinator()
