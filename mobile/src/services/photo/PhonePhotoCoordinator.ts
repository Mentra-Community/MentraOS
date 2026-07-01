/**
 * PhonePhotoCoordinator — owns local-miniapp takePhoto() end-to-end.
 *
 * Architecture:
 *   miniapp → SDK → LocalMiniappRuntime → photo runtime hook
 *          → coordinator.takePhoto(packageName, opts)
 *            ├── (precheck) glasses connected + hasCamera
 *            ├── cloudClient.startManagedPhoto → {requestId, uploadUrl, readUrl}  (cloud-v2 runtime presign)
 *            ├── BluetoothSdk.requestPhoto(requestId, size, uploadUrl, compress, sound)
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
import {type PhotoResult} from "./v2PhotoApi"

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

let bleRequestCounter = 0

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
  // Cloud requestId → in-flight slot. MantleManager resolves short BLE ids
  // via bleIdToCloud before calling owns() / handlePhotoError().
  private readonly activeRequests = new Map<string, ActiveRequest>()
  /** Short BLE correlation id (4-char hex) → full cloud requestId. */
  private readonly bleIdToCloud = new Map<string, string>()

  async takePhoto(packageName: string, opts: PhotoOpts): Promise<PhotoTaken> {
    const glasses = getRuntimeHooks().glassesStatus?.get()
    if (!glasses?.connected) {
      throw new PhotoError("GLASSES_NOT_CONNECTED", "Glasses are not connected", "command", "ble")
    }

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

    const isLoopbackUpload = /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)\b/.test(uploadUrl)

    const abort = new AbortController()
    const bleRequestId = mintBleRequestId()
    this.bleIdToCloud.set(bleRequestId, requestId)

    const outcome = new Promise<PhotoResult>((resolve, reject) => {
      this.activeRequests.set(requestId, {packageName, abort, resolve, reject})
    })

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

    try {
      void BluetoothSdk.requestPhoto({
        requestId: bleRequestId,
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
      this.bleIdToCloud.delete(bleRequestId)
      throw this.toPhotoError(err, "BLE_SEND_FAILED", "command", "ble")
    }

    cloudClient
      .awaitManagedPhotoReady(requestId)
      .then((res) => {
        const e = this.activeRequests.get(requestId)
        if (!e) return
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
   * Pure BLE — NO cloud presign, NO upload, NO long-poll. The SDK mints the
   * requestId, sends the warm-up command, and resolves when the camera reports
   * ready (the native promise resolves on the ready status event).
   */
  async warmUpCamera(
    packageName: string,
    opts: {size?: "low" | "medium" | "high" | "max"; exposureTimeNs?: number; durationMs?: number},
  ): Promise<void> {
    const glasses = getRuntimeHooks().glassesStatus?.get()
    if (!glasses?.connected) {
      throw new PhotoError("GLASSES_NOT_CONNECTED", "Glasses are not connected", "command", "ble")
    }

    try {
      await BluetoothSdk.warmUpCamera({
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
    entry.abort.abort()
    entry.reject(new PhotoError(errorCode || "GLASSES_ERROR", errorMessage || "Glasses error", "capture", "ble"))
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

export const phonePhotoCoordinator = new PhonePhotoCoordinator()
