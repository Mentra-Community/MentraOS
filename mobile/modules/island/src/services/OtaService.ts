/**
 * OTA service — island-owned. Subscribes to the glasses' OTA BLE events and projects
 * them into the island glasses store (otaUpdateAvailable / otaStatus / otaProgress), so
 * the OTA read surface works for ANY host — not just the first-party Mentra app, where
 * these handlers used to live in MantleManager.
 *
 * This is the inbound projection half of `toolkit.ota` (read/observe). The install
 * ORCHESTRATION (startOtaUpdate/poll/ping) is host-side for now — Phase 2 moves it here
 * behind `toolkit.ota.{check,install,retry}` (bootloop-risk; needs on-device verification).
 *
 * Started by `toolkit.start()`. Idempotent.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {OtaStatus} from "@mentra/bluetooth-sdk/internal"
import GlobalEventEmitter from "../utils/GlobalEventEmitter"
import {useGlassesStore} from "../stores/glasses"
import {isGlassesConnected} from "./GlassesReadiness"
import {handleOtaClockSkewFromGlasses} from "./glassesClockSync"
import {
  legacyOtaProgressFromOtaStatusEvent,
  normalizeOtaStatusEvent,
  otaStatusFromNormalized,
} from "./otaLegacyMapping"

let subs: Array<{remove: () => void}> = []

export function startOtaService(): void {
  if (subs.length) return

  // An update is available on the glasses (cache-ready or manifest-detected).
  subs.push(
    BluetoothSdk.addListener("ota_update_available", (event) => {
      if (!isGlassesConnected(useGlassesStore.getState().connection)) return
      useGlassesStore.getState().setOtaUpdateAvailable({
        available: true,
        versionCode: event.version_code ?? 0,
        versionName: event.version_name ?? "",
        updates: event.updates ?? [],
        totalSize: event.total_size ?? 0,
        cacheReady: event.cache_ready === true,
      })
      GlobalEventEmitter.emit("ota_update_available", {
        versionCode: event.version_code,
        versionName: event.version_name,
        updates: event.updates,
        totalSize: event.total_size,
      })
    }),
  )

  // MTK firmware update finished (self power-cycle path).
  subs.push(
    BluetoothSdk.addListener("mtk_update_complete", (event) => {
      GlobalEventEmitter.emit("mtk_update_complete", {message: event.message, timestamp: event.timestamp})
    }),
  )

  // Glasses acknowledged the install start.
  subs.push(
    BluetoothSdk.addListener("ota_start_ack", (event) => {
      GlobalEventEmitter.emit("ota_start_ack", {timestamp: event.timestamp})
    }),
  )

  // Install progress / lifecycle. Updates both the new (otaStatus) and the legacy
  // (otaProgress) store shapes; auto-fixes clock skew on the relevant failures.
  subs.push(
    BluetoothSdk.addListener("ota_status", (event) => {
      const normalized = normalizeOtaStatusEvent(event as Record<string, unknown>)
      const status: OtaStatus = otaStatusFromNormalized(normalized)
      useGlassesStore.getState().setOtaStatus(status)
      // Emit before legacy progress: setOtaProgress can throw (e.g. JSON.stringify in store);
      // native logs would still show while RN UI would stay on "Starting update…".
      GlobalEventEmitter.emit("ota_status", status)
      try {
        useGlassesStore.getState().setOtaProgress(legacyOtaProgressFromOtaStatusEvent(normalized))
      } catch (err) {
        console.warn("OTA: ota_status legacy otaProgress mapping failed", err)
      }

      if (status.status === "failed") {
        const raw = event as Record<string, unknown>
        const glassesTimeMs = Number(raw.glasses_time_ms ?? raw.glassesTimeMs ?? 0) || undefined
        const errorCode = normalized.error_message
        if (
          errorCode === "clock_skew" ||
          (errorCode === "ssl_error" && typeof glassesTimeMs === "number" && Number.isFinite(glassesTimeMs))
        ) {
          handleOtaClockSkewFromGlasses(errorCode, glassesTimeMs).catch((err: unknown) => {
            console.warn("OTA: clock skew auto-fix failed", err)
          })
        }
      }

      if (status.status === "complete" || status.status === "failed") {
        useGlassesStore.getState().setOtaUpdateAvailable(null)
      }
    }),
  )
}

export function stopOtaService(): void {
  subs.forEach((s) => s.remove())
  subs = []
}
