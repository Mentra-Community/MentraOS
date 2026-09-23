/** Live compatibility surface. Legacy and managed controllers share one execution reservation. */
import BluetoothSdk from "@mentra/bluetooth-sdk"
import {liveOtaPorts} from "../devices/mentra-live/ports"
import {acquireLegacyLiveOwner, assertLegacyLiveControlAvailable} from "../devices/mentra-live/ownership"
import {otaInstallCoordinator} from "../services/OtaInstallCoordinator"
import {FirmwareUpdateError} from "../ota/types"

export type {
  OtaSnapshot,
  OtaProgress,
  OtaProgressStatus,
  OtaStatus,
  OtaUpdateInfo,
  ReleaseChangelog,
  OtaInstallSnapshot,
  OtaCheckCurrentGlassesOptions,
  OtaCheckCurrentGlassesResult,
} from "../devices/mentra-live/ports"

let legacyRelease: (() => void) | null = null
let legacySession = false
let commands = 0

function reserveLegacy(): void {
  assertLegacyLiveControlAvailable()
  if (legacyRelease) return
  let nativeDeviceId: string | null = null
  legacyRelease = acquireLegacyLiveOwner(
    async () => {
      const device = await BluetoothSdk.getDefaultDevice()
      if (!device || device.model !== "Mentra Live" || (nativeDeviceId && device.id !== nativeDeviceId))
        throw new FirmwareUpdateError("stale_offer", "The paired Live glasses changed")
      nativeDeviceId = device.id
    },
    () => liveOtaPorts.installSession.retry(),
    () => nativeDeviceId,
  )
}

function releaseIdleReservation(): void {
  if (legacySession || commands) return
  legacyRelease?.()
  legacyRelease = null
}

function control<A extends unknown[], R>(fn: (...args: A) => R, retain = false): (...args: A) => R {
  return (...args) => {
    reserveLegacy()
    if (retain) legacySession = true
    commands++
    const done = () => {
      commands--
      releaseIdleReservation()
    }
    try {
      const result = fn(...args)
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function")
        return Promise.resolve(result).finally(done) as R
      done()
      return result
    } catch (error) {
      done()
      throw error
    }
  }
}

export const ota = {
  ...liveOtaPorts,
  install: control(liveOtaPorts.install),
  checkForUpdates: control(liveOtaPorts.checkForUpdates),
  clearUpdateAvailable: control(liveOtaPorts.clearUpdateAvailable),
  clearProgress: control(liveOtaPorts.clearProgress),
  replacePendingUpdateSequence: control(liveOtaPorts.replacePendingUpdateSequence),
  clearBuildNumberForNextCheck: control(liveOtaPorts.clearBuildNumberForNextCheck),
  markMtkUpdatedThisSession: control(liveOtaPorts.markMtkUpdatedThisSession),
  installSession: {
    ...liveOtaPorts.installSession,
    prepare: control(liveOtaPorts.installSession.prepare, true),
    attach: control(liveOtaPorts.installSession.attach, true),
    detach: () => {
      assertLegacyLiveControlAvailable()
      // A view can disappear while firmware still owns the glasses. Keep its controller
      // and reservation until terminal cleanup makes a later detach safe.
      if (legacySession && !otaInstallCoordinator.isSafeToRelease()) return
      liveOtaPorts.installSession.detach()
      legacySession = false
      releaseIdleReservation()
    },
    retry: control(liveOtaPorts.installSession.retry),
    finish: control(liveOtaPorts.installSession.finish),
    discard: control(liveOtaPorts.installSession.discard),
  },
}
