import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react"

import {openMentraLiveOtaProvider} from "../devices/mentra-live/sessionRegistry"
import {MentraLiveOtaSession} from "../devices/mentra-live/session"
import {liveOtaPorts} from "../devices/mentra-live/ports"
import type {MentraLiveFirmwareProvider} from "../devices/mentra-live/provider"
import type {MentraLiveOtaController, UseMentraLiveOtaOptions} from "../devices/mentra-live/types"
import {firmwareUpdates} from "../facades/firmwareUpdates"
import type {FirmwareAction} from "../ota/types"

export * from "../devices/mentra-live/types"
export {MINIMUM_OTA_BATTERY_LEVEL} from "../devices/mentra-live/session"

/** Compatibility view over the same registered provider used by device-neutral OTA entry points. */
export function useMentraLiveOta(options: UseMentraLiveOtaOptions = {}): MentraLiveOtaController {
  // A passive initial projection keeps the public state shape synchronous while native identity resolves.
  const [initial] = useState(() => new MentraLiveOtaSession(liveOtaPorts))
  const [provider, setProvider] = useState<MentraLiveFirmwareProvider | null>(null)
  const [openError, setOpenError] = useState<Error | null>(null)
  const [openGeneration, setOpenGeneration] = useState(0)
  const session = provider?.session ?? initial
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot)
  const callbacks = useRef(options)
  callbacks.current = options

  useEffect(() => {
    let observing = true
    setOpenError(null)
    void openMentraLiveOtaProvider({
      entryPoint: "recovery",
      legacyProgressEntry: options.initialPage === "progress",
      initializeRuntime: options.initializeRuntime,
      allowDevelopmentSkip: options.allowDevelopmentSkip,
    })
      .then((value) => {
        if (observing) setProvider(value)
      })
      .catch((error) => {
        if (observing) setOpenError(error instanceof Error ? error : new Error(String(error)))
      })
    return () => {
      observing = false
    }
  }, [openGeneration])

  useEffect(() => {
    if (provider && snapshot.exitRequest && session.claimExitRequest(snapshot.exitRequest))
      callbacks.current.onFinished?.()
  }, [provider, session, snapshot.exitRequest])

  useEffect(() => {
    if (snapshot.page === "progress")
      callbacks.current.onFirmwareRestartingChange?.(snapshot.state.firmwareRestarting, true)
  }, [snapshot.page, snapshot.state.firmwareRestarting])
  useEffect(() => {
    if (snapshot.page !== "progress") return
    return () => callbacks.current.onFirmwareRestartingChange?.(false, false)
  }, [snapshot.page])

  const perform = useCallback(
    (action: FirmwareAction) => {
      if (!provider) {
        if (action === "check" || action === "retry") setOpenGeneration((value) => value + 1)
        return
      }
      void firmwareUpdates
        .perform(provider.target, {action, offerId: provider.snapshot().offer?.id})
        .then((result) => {
          if (result.kind === "finished") callbacks.current.onFinished?.()
          else if (result.kind === "wifi-required") callbacks.current.onOpenWifiSetup?.()
        })
        .catch((error) => console.warn(`Live update ${action} failed`, error))
    },
    [provider],
  )

  return useMemo(
    () => ({
      state: openError
        ? {
            ...snapshot.state,
            screen: "check_failed" as const,
            canRetry: true,
            error: {code: "check_failed" as const, message: openError.message},
          }
        : snapshot.state,
      check: () => perform("check"),
      retryCheck: () => perform("retry"),
      install: () => perform("install"),
      retryInstall: () => perform("retry"),
      finish: () => perform("finish"),
      discard: () => perform("discard"),
      openWifiSetup: () => perform("wifi"),
    }),
    [snapshot.state, perform, openError],
  )
}
