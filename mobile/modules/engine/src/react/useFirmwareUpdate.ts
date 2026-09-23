import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from "react"

import {firmwareUpdates} from "../facades/firmwareUpdates"
import type {
  FirmwareAction,
  FirmwareFinishResult,
  FirmwareOpenOptions,
  FirmwareSnapshot,
  FirmwareTarget,
} from "../ota/types"

export interface UseFirmwareUpdateOptions extends FirmwareOpenOptions {
  onFinished?: (result?: FirmwareFinishResult) => void
  onOpenWifiSetup?: () => void
  onSnapshot?: (snapshot: FirmwareSnapshot) => void
}

/** Views observe a retained provider. Unmounting never cancels an update or disposes its native owner. */
export function useFirmwareUpdate(target: FirmwareTarget, options: UseFirmwareUpdateOptions) {
  const [error, setError] = useState<Error | null>(null)
  const [opening, setOpening] = useState(true)
  const [openRevision, setOpenRevision] = useState(0)
  const callbacks = useRef(options)
  callbacks.current = options
  const mounted = useRef(false)
  const observationGeneration = useRef(0)
  const currentTarget = useRef("")
  currentTarget.current = JSON.stringify([target.integrationId, target.deviceId])
  const subscribe = useCallback(
    (listener: () => void) => firmwareUpdates.subscribe(target, listener),
    [target.integrationId, target.deviceId],
  )
  const read = useCallback(() => firmwareUpdates.snapshot(target), [target.integrationId, target.deviceId])
  const snapshot = useSyncExternalStore(subscribe, read, read)

  useEffect(() => {
    mounted.current = true
    observationGeneration.current++
    let observing = true
    setOpening(true)
    setError(null)
    void firmwareUpdates.open(target, callbacks.current).then(
      () => {
        if (observing) setOpening(false)
      },
      (failure) => {
        if (observing) {
          setOpening(false)
          setError(failure instanceof Error ? failure : new Error(String(failure)))
        }
      },
    )
    return () => {
      observing = false
      mounted.current = false
      observationGeneration.current++
    }
  }, [
    target.integrationId,
    target.deviceId,
    openRevision,
    options.entryPoint,
    options.initializeRuntime,
    options.legacyProgressEntry,
    options.allowDevelopmentSkip,
  ])

  useEffect(() => {
    callbacks.current.onSnapshot?.(snapshot)
  }, [snapshot])

  const perform = useCallback(
    async (action: FirmwareAction) => {
      const requestedTarget = JSON.stringify([target.integrationId, target.deviceId])
      const generation = observationGeneration.current
      setError(null)
      try {
        const result = await firmwareUpdates.perform(target, {
          action,
          offerId: firmwareUpdates.snapshot(target).offer?.id,
        })
        if (
          !mounted.current ||
          generation !== observationGeneration.current ||
          currentTarget.current !== requestedTarget
        )
          return
        if (result.kind === "finished") callbacks.current.onFinished?.(result)
        else if (result.kind === "wifi-required") callbacks.current.onOpenWifiSetup?.()
      } catch (failure) {
        if (
          mounted.current &&
          generation === observationGeneration.current &&
          currentTarget.current === requestedTarget
        )
          setError(failure instanceof Error ? failure : new Error(String(failure)))
      }
    },
    [target.integrationId, target.deviceId],
  )

  return {snapshot, opening, error, perform, retryOpen: () => setOpenRevision((revision) => revision + 1)}
}
