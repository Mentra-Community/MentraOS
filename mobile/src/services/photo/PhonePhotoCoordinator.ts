/**
 * PhonePhotoCoordinator — owns local-miniapp takePhoto() end-to-end.
 *
 * Architecture:
 *   miniapp → SDK → LocalMiniappRuntime → photo runtime hook
 *          → coordinator.takePhoto(packageName, opts)
 *            ├── (precheck) glasses connected + hasCamera
 *            ├── v2PhotoApi.requestPhoto → {requestId, uploadUrl, uploadToken}
 *            ├── BluetoothSdk.requestPhoto(requestId, packageName, size, uploadUrl, uploadToken, compress, sound)
 *            └── race:
 *                  - v2PhotoApi.pollUntilReady(requestId) resolves on /upload
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

import {freePhoto, pollUntilReady, requestPhoto, type PhotoResult} from "./v2PhotoApi"

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

    // 1) Mint token + upload URL.
    let requestId: string
    let uploadUrl: string
    let uploadToken: string
    try {
      const r = await requestPhoto()
      requestId = r.requestId
      uploadUrl = r.uploadUrl
      uploadToken = r.uploadToken
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
    try {
      void BluetoothSdk.requestPhoto({
        requestId,
        appId: packageName,
        size: opts.size ?? "medium",
        webhookUrl: uploadUrl,
        authToken: uploadToken,
        compress: toNativeCompression(opts.compress),
        save: opts.saveToGallery ?? false,
        sound: opts.sound ?? true,
        exposureTimeNs: opts.exposureTimeNs ?? null,
      }).catch((err) => {
        const e = this.activeRequests.get(requestId)
        if (!e) return
        e.abort.abort()
        e.reject(this.toPhotoError(err, "BLE_SEND_FAILED"))
        // Best-effort free the slot on cloud — saves orphan slots.
        void freePhoto(requestId)
      })
    } catch (err) {
      this.activeRequests.delete(requestId)
      // Best-effort free the slot on cloud — saves orphan slots.
      void freePhoto(requestId)
      throw this.toPhotoError(err, "BLE_SEND_FAILED")
    }

    // 4) Kick off the long-poll. settleFromPoll() resolves or rejects via
    //    the entry; handlePhotoError races against it and uses the same
    //    entry to reject first.
    pollUntilReady(requestId, abort.signal)
      .then((res) => {
        const e = this.activeRequests.get(requestId)
        if (!e) return // already settled by handlePhotoError
        if (res.kind === "ready") e.resolve(res.result)
        else e.reject(new PhotoError(res.code, res.message))
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
    // Best-effort: tell cloud to drop the (now-orphan) slot.
    void freePhoto(requestId)
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
