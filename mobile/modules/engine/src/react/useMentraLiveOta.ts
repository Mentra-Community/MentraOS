import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react"

import {resolveMentraLiveOtaProvider} from "../devices/mentra-live/sessionRegistry"
import {MentraLiveOtaSession} from "../devices/mentra-live/session"
import {liveOtaPorts} from "../devices/mentra-live/ports"
import type {MentraLiveFirmwareProvider} from "../devices/mentra-live/provider"
import type {MentraLiveOtaController, UseMentraLiveOtaOptions} from "../devices/mentra-live/types"
import {firmwareUpdates, firmwareUpdateService} from "../facades/firmwareUpdates"
import type {FirmwareAction, FirmwareTarget} from "../ota/types"

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
  const subscribe = useCallback(
    (listener: () => void) => (provider ? provider.subscribe(listener) : initial.subscribe(listener)),
    [provider, initial],
  )
  const getSnapshot = useCallback(() => (provider?.session ?? initial).snapshot(), [provider, initial])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const callbacks = useRef(options)
  callbacks.current = options

  const viewGeneration = useRef(0)
  const openingTarget = useRef<FirmwareTarget | undefined>(options.target)
  const closed = useRef(false)
  const integrationId = options.target?.integrationId
  const deviceId = options.target?.deviceId
  const displayName = options.target?.displayName
  const entryPoint = options.entryPoint ?? "recovery"
  const legacyProgressEntry = options.initialPage === "progress"
  const initializeRuntime = options.initializeRuntime
  const allowDevelopmentSkip = options.allowDevelopmentSkip

  useEffect(() => {
    let observing = true
    viewGeneration.current += 1
    closed.current = false
    openingTarget.current =
      integrationId && deviceId ? {integrationId, deviceId, displayName: displayName ?? "Mentra Live"} : undefined
    setProvider(null)
    setOpenError(null)
    void resolveMentraLiveOtaProvider(openingTarget.current)
      .then(async (value) => {
        if (!observing) return null
        openingTarget.current = value.target
        await firmwareUpdates.open(value.target, {
          entryPoint,
          legacyProgressEntry,
          initializeRuntime,
          allowDevelopmentSkip,
        })
        return value
      })
      .then((value) => {
        if (observing && value) setProvider(value)
      })
      .catch((error) => {
        if (observing) setOpenError(error instanceof Error ? error : new Error(String(error)))
      })
    return () => {
      observing = false
      closed.current = true
      viewGeneration.current += 1
    }
  }, [
    openGeneration,
    integrationId,
    deviceId,
    displayName,
    entryPoint,
    legacyProgressEntry,
    initializeRuntime,
    allowDevelopmentSkip,
  ])

  useEffect(() => {
    if (provider && snapshot.exitRequest && session.claimExitRequest(snapshot.exitRequest)) {
      const generation = viewGeneration.current
      void firmwareUpdates
        .perform(provider.target, {action: "finish"})
        .then((result) => {
          if (generation !== viewGeneration.current) return
          if (result.kind === "finished") callbacks.current.onFinished?.()
        })
        .catch((error) => console.warn("Could not finish the Live check", error))
    }
  }, [provider, session, snapshot.exitRequest])

  useEffect(() => {
    if (snapshot.page === "progress")
      callbacks.current.onFirmwareRestartingChange?.(snapshot.state.firmwareRestarting, true)
  }, [snapshot.page, snapshot.state.screen, snapshot.state.firmwareRestarting])
  useEffect(() => {
    if (provider) callbacks.current.onSnapshot?.(provider.snapshot())
  }, [provider, snapshot])
  useEffect(() => {
    if (snapshot.page !== "progress") return
    return () => callbacks.current.onFirmwareRestartingChange?.(false, false)
  }, [snapshot.page])

  const renderedGeneration = viewGeneration.current
  const perform = useCallback(
    (action: FirmwareAction) => {
      if (closed.current || renderedGeneration !== viewGeneration.current) return
      if (!provider) {
        if (action === "check" || action === "retry") setOpenGeneration((value) => value + 1)
        else if (action === "finish" && openError && !closed.current) {
          try {
            const result = firmwareUpdateService.closeFailedOpen(openingTarget.current, entryPoint)
            closed.current = true
            callbacks.current.onFinished?.(result)
          } catch (error) {
            setOpenError(error instanceof Error ? error : new Error(String(error)))
          }
        }
        return
      }
      const generation = viewGeneration.current
      void firmwareUpdates
        .perform(provider.target, {action, offerId: provider.snapshot().offer?.id})
        .then((result) => {
          if (generation !== viewGeneration.current) return
          if (result.kind === "finished") callbacks.current.onFinished?.()
          else if (result.kind === "wifi-required") callbacks.current.onOpenWifiSetup?.()
        })
        .catch((error) => console.warn(`Live update ${action} failed`, error))
    },
    [provider, openError, entryPoint, renderedGeneration],
  )

  return useMemo(
    () => ({
      state: openError
        ? {
            ...snapshot.state,
            screen: "check_failed" as const,
            canRetry: true,
            canDismiss: true,
            error: {code: "check_failed" as const, message: openError.message},
          }
        : {
            ...snapshot.state,
            canDiscard: provider?.snapshot().presentation.actions.some((action) => action.id === "discard") ?? false,
          },
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
