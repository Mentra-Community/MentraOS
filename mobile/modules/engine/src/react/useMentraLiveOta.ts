import {useCallback, useEffect, useMemo, useRef, useState} from "react"

import {getMentraLiveOtaSession, releaseMentraLiveOtaSession} from "../devices/mentra-live/sessionRegistry"
import type {MentraLiveOtaController, UseMentraLiveOtaOptions} from "../devices/mentra-live/types"
import type {FirmwareActionResult} from "../ota/types"
import {useEngineSnapshot} from "./useEngineSnapshot"

export * from "../devices/mentra-live/types"
export {MINIMUM_OTA_BATTERY_LEVEL} from "../devices/mentra-live/session"

/** Public view binding. The headless Live session survives view unsubscription. */
export function useMentraLiveOta(options: UseMentraLiveOtaOptions = {}): MentraLiveOtaController {
  const [session] = useState(getMentraLiveOtaSession)
  const snapshot = useEngineSnapshot(session.snapshot, session.subscribe)
  const callbacks = useRef(options)
  callbacks.current = options
  const initialExit = useRef(snapshot.exitRequest)

  useEffect(() => {
    void session
      .open({initialPage: options.initialPage, initializeRuntime: options.initializeRuntime})
      .catch((error) => {
        console.warn("Could not initialize the Live update flow", error)
      })
  }, [session])

  useEffect(() => {
    if (snapshot.exitRequest > initialExit.current && session.claimExitRequest(snapshot.exitRequest)) {
      releaseMentraLiveOtaSession(session)
      callbacks.current.onFinished?.()
    }
  }, [session, snapshot.exitRequest])

  useEffect(() => {
    if (snapshot.page === "progress")
      callbacks.current.onFirmwareRestartingChange?.(snapshot.state.firmwareRestarting, true)
  }, [snapshot.page, snapshot.state.firmwareRestarting])

  useEffect(() => {
    if (snapshot.page !== "progress") return
    return () => callbacks.current.onFirmwareRestartingChange?.(false, false)
  }, [snapshot.page])

  const deliver = useCallback(
    (result: FirmwareActionResult) => {
      if (result.kind === "finished") {
        releaseMentraLiveOtaSession(session)
        callbacks.current.onFinished?.()
      } else if (result.kind === "wifi-required") {
        callbacks.current.onOpenWifiSetup?.()
      }
    },
    [session],
  )

  const install = useCallback(() => deliver(session.install()), [deliver, session])
  const retryInstall = useCallback(() => {
    if (session.snapshot().page === "progress") callbacks.current.onFirmwareRestartingChange?.(false, true)
    session.retryInstall()
  }, [session])
  const finish = useCallback(() => {
    const result = session.finish()
    if (result instanceof Promise) {
      void result.then(deliver).catch((error) => console.warn("Could not finish Live update cleanup", error))
    } else deliver(result)
  }, [deliver, session])
  const discard = useCallback(() => {
    void session
      .discard()
      .then(deliver)
      .catch((error) => console.warn("Could not discard Live update", error))
  }, [deliver, session])
  const openWifiSetup = useCallback(() => deliver(session.openWifiSetup()), [deliver, session])

  return useMemo(
    () => ({
      state: snapshot.state,
      check: session.check,
      retryCheck: session.check,
      install,
      retryInstall,
      finish,
      discard,
      openWifiSetup,
    }),
    [snapshot.state, session, install, retryInstall, finish, discard, openWifiSetup],
  )
}
