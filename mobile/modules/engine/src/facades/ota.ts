/** Live compatibility surface. Observation is passive; managed sessions exclusively own controls. */
import {liveOtaPorts} from "../devices/mentra-live/ports"
import {assertLegacyLiveControlAvailable} from "../devices/mentra-live/ownership"

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

function control<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    assertLegacyLiveControlAvailable()
    return fn(...args)
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
    prepare: control(liveOtaPorts.installSession.prepare),
    attach: control(liveOtaPorts.installSession.attach),
    detach: control(liveOtaPorts.installSession.detach),
    retry: control(liveOtaPorts.installSession.retry),
    finish: control(liveOtaPorts.installSession.finish),
    discard: control(liveOtaPorts.installSession.discard),
  },
}
