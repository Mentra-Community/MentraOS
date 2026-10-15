import {useIsFocused, useRoute} from "@react-navigation/native"
import BluetoothSdk, {type Device, type PairingInfoEvent} from "@mentra/bluetooth-sdk"
import {engine, DeviceTypes} from "@mentra/engine"
import type {PairFailureEvent} from "@mentra/engine"
import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {Platform, View} from "react-native"

import {Button} from "@/components/ignite"
import {Header} from "@/components/ignite/Header"
import {Screen} from "@/components/ignite/Screen"
import GlassesPairingLoader from "@/components/glasses/GlassesPairingLoader"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import {isG2RecoveryError} from "@/utils/pairing/g2Recovery"
import {IOS_FORGET_GLASSES_BLUETOOTH_ERROR} from "@/utils/pairing/iosStaleBond"
import {
  BT_CLASSIC_ROUTE,
  IOS_CLASSIC_SETTLE_MS,
  REPLACE_OWNER_ROUTE,
  classicWaitState,
  shouldRouteToReplaceOwner,
} from "@/utils/pairing/replaceOwner"
import {isReplaceOwnerConfirmSettling} from "@/utils/pairing/replaceOwnerConfirm"
import {
  advertisedSecurePairingCapable,
  isMentraLiveOwnershipTransferSupported,
  isMentraLiveSecurePairingEnabled,
} from "@/utils/pairing/securePairingFeature"

// Secure pairing info should arrive immediately after Mentra Live finishes booting.
// Secure or unknown firmware fails closed instead of spinning forever.
const PAIRING_INFO_WAIT_MS = 5_000
const PAIRING_KICKOFF_DELAY_MS = 2_000

/**
 * Design A (open reclaim): three presses clear prior owner/bonds on the glasses; the first
 * successful pair wins. Mentra Live pairing does NOT run ownership-transfer finalize/wipe.
 * pairing_info is used only as a secure-firmware readiness signal; the advertised capability
 * lets existing customer firmware proceed without waiting for an event it does not emit.
 * Route params arrive as strings, so legacy firmware is both boolean false and "false".
 *
 * Ownership transfer is the exception to open reclaim: glasses in transfer mode report
 * `pairing_info.awaiting_confirm` and refuse to bond until a different phone confirms
 * on the replace-owner screen, which is pushed on top of this one and pops back here
 * once confirmed. The phone that already owns the glasses is never blocked: it gets
 * `retained_owner_link`, keeps waiting, and the glasses reclaim it. Routing keys on awaiting_confirm, never on
 * had_previous_bond. iOS
 * waits for Classic to bond from the BLE pair and opens Settings only if that
 * bond does not appear. Android attaches Classic from the BLE bond.
 */
export default function GlassesPairingLoadingScreen() {
  const {replace, goBack} = useNavigationStore.getState()
  const route = useRoute()
  const {
    device: deviceJson,
    deviceModel,
    deviceName,
    ar99ProjectName,
    securePairingCapable,
    pairingCode,
  } = route.params as {
    device?: string
    deviceModel: string
    deviceName?: string
    ar99ProjectName?: string
    /** Known upfront from the scan result's advertised capability, before any pairing_info event. */
    securePairingCapable?: boolean
    pairingCode?: string
  }
  const isFocused = useIsFocused()
  const selectedDevice = useMemo((): Device | null => {
    if (!deviceJson) return null
    try {
      const device = JSON.parse(deviceJson) as Device
      if (device.model !== deviceModel || (deviceName && device.name !== deviceName)) return null
      return device
    } catch {
      return null
    }
  }, [deviceJson, deviceModel, deviceName])
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const hasNavigatedRef = useRef(false)
  const navigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [selectedTargetReady, setSelectedTargetReady] = useState(false)
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)
  const [pairingInfoReceived, setPairingInfoReceived] = useState(false)
  const [pairingKickoffComplete, setPairingKickoffComplete] = useState(false)
  const pairingKickoffStartedRef = useRef(false)
  const pairingKickoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pairingStoppedRef = useRef(false)
  const replaceOwnerRoutedRef = useRef(false)
  const classicAudioRoutedRef = useRef(false)
  const classicSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readiness = useEngineSnapshot(engine.pairing.readiness, (onChange) => engine.pairing.onReadiness(onChange))
  const {bluetoothClassicConnected, bluetoothClassicProfilesConnected, bluetoothAudioRouted} = readiness
  const [classicSettleElapsed, setClassicSettleElapsed] = useState(false)
  const isMentraLive = deviceModel === DeviceTypes.LIVE
  const advertisedSecurePairing = advertisedSecurePairingCapable(
    securePairingCapable,
    selectedDevice?.securePairingCapable,
  )
  const securePairingRequired = isMentraLive && isMentraLiveSecurePairingEnabled() && advertisedSecurePairing !== false
  const pairingTimingStartRef = useRef(Date.now())
  const pairingTimingLastRef = useRef(Date.now())

  const logPairingTiming = useCallback((checkpoint: string, detail?: string) => {
    const now = Date.now()
    const sinceStartMs = now - pairingTimingStartRef.current
    const deltaMs = now - pairingTimingLastRef.current
    pairingTimingLastRef.current = now
    const extra = detail ? ` ${detail}` : ""
    console.log(`PAIRING_TIMING checkpoint=${checkpoint} sinceStartMs=${sinceStartMs} deltaMs=${deltaMs}${extra}`)
  }, [])

  useEffect(() => {
    pairingTimingStartRef.current = Date.now()
    pairingTimingLastRef.current = pairingTimingStartRef.current
    logPairingTiming("loading_mount", `deviceModel=${deviceModel} deviceName=${deviceName ?? ""}`)
  }, [deviceModel, deviceName, logPairingTiming])

  useEffect(() => {
    const target = {deviceModel, deviceName}
    const observeReadiness = (ready: boolean) => {
      setSelectedTargetReady(ready)
      if (!ready && navigationTimerRef.current) {
        clearTimeout(navigationTimerRef.current)
        navigationTimerRef.current = null
        if (!pairingStoppedRef.current) hasNavigatedRef.current = false
      }
    }
    const unsubscribe = engine.pairing.onTargetReady(target, observeReadiness)
    observeReadiness(engine.pairing.targetReady(target))

    return unsubscribe
  }, [deviceModel, deviceName])

  useEffect(() => {
    const unsub = engine.pairing.onGlassesNotReady(() => {
      setShowGlassesBooting(true)
      logPairingTiming("glasses_not_ready_ui")
    })
    return () => {
      unsub()
    }
  }, [logPairingTiming])

  useEffect(() => {
    if (!securePairingRequired) {
      return
    }

    const sub = BluetoothSdk.addListener("pairing_info", (event: PairingInfoEvent) => {
      if (!pairingKickoffStartedRef.current) return

      const advertisedCode = pairingCode?.trim().toUpperCase()
      const eventCode = typeof event.pairing_code === "string" ? event.pairing_code.trim().toUpperCase() : undefined
      if (advertisedCode && eventCode && eventCode !== advertisedCode) {
        logPairingTiming("ignoring_pairing_info_for_other_device")
        return
      }
      setPairingInfoReceived(true)
      logPairingTiming(
        "pairing_info",
        `had_previous_bond=${event.had_previous_bond} secure=${event.secure_pairing_capable} awaiting_confirm=${String(
          event.awaiting_confirm,
        )} retained_owner_link=${String(event.retained_owner_link)} design=A_open_reclaim`,
      )

      if (event.retained_owner_link === true) {
        // This phone is the owner the glasses kept and the user is pairing on purpose. The
        // glasses never block the owner: they reclaim and send a fresh pairing_info with
        // owner_committed, so keep waiting instead of leaving or showing the replace prompt.
        logPairingTiming("retained_owner_reclaim_wait")
        return
      }

      if (
        shouldRouteToReplaceOwner({
          platformSupported: isMentraLiveOwnershipTransferSupported(),
          awaitingConfirm: event.awaiting_confirm,
          securePairing: securePairingRequired,
          retainedOwnerLink: event.retained_owner_link,
        })
      ) {
        // One push per awaiting_confirm episode; replayed pairing_info must not stack screens.
        if (replaceOwnerRoutedRef.current || hasNavigatedRef.current || pairingStoppedRef.current) return
        // A queued awaiting_confirm from before the user's tap must not reopen the screen.
        if (isReplaceOwnerConfirmSettling()) return
        replaceOwnerRoutedRef.current = true
        console.log(
          `PAIRFLOW: loading_navigate route=${REPLACE_OWNER_ROUTE} model=${deviceModel} name=${deviceName ?? ""}`,
        )
        logPairingTiming("navigate_replace_owner")
        useNavigationStore.getState().push(REPLACE_OWNER_ROUTE, {deviceModel, deviceName})
      } else if (event.awaiting_confirm !== true) {
        // The glasses moved past the confirm state; a later one is a new episode.
        replaceOwnerRoutedRef.current = false
      }
    })

    return () => {
      sub.remove()
    }
  }, [securePairingRequired, pairingCode, logPairingTiming, deviceModel, deviceName, replace])

  const handleGoBack = useCallback(() => {
    console.log(`PAIRFLOW: loading_cancel model=${deviceModel} name=${deviceName ?? ""}`)
    pairingStoppedRef.current = true
    hasNavigatedRef.current = true
    if (pairingKickoffTimerRef.current) {
      clearTimeout(pairingKickoffTimerRef.current)
      pairingKickoffTimerRef.current = null
    }
    if (navigationTimerRef.current) {
      clearTimeout(navigationTimerRef.current)
      navigationTimerRef.current = null
    }
    void engine.pairing.abandonAttempt().catch((cleanupError) => {
      console.warn("Pairing cancellation cleanup failed:", cleanupError)
    })
    goBack()
  }, [deviceModel, deviceName, goBack])

  const handlePairFailure = useCallback(
    (error: string) => {
      if (pairingStoppedRef.current || hasNavigatedRef.current) return
      console.log(`PAIRFLOW: loading_fail error=${error} model=${deviceModel} name=${deviceName ?? ""}`)
      pairingStoppedRef.current = true
      hasNavigatedRef.current = true
      if (pairingKickoffTimerRef.current) {
        clearTimeout(pairingKickoffTimerRef.current)
        pairingKickoffTimerRef.current = null
      }
      if (navigationTimerRef.current) {
        clearTimeout(navigationTimerRef.current)
        navigationTimerRef.current = null
      }
      void engine.pairing.abandonAttempt().catch((cleanupError) => {
        console.warn("Pairing failure cleanup failed:", cleanupError)
      })
      if (error === "errors:pairNeedDisconnect" || (deviceModel === DeviceTypes.G2 && isG2RecoveryError(error))) {
        replace("/pairing/unpair-even", {deviceModel, error})
        return
      }
      // Only the forget-in-Settings screen names the glasses.
      replace(
        "/pairing/failure",
        error === IOS_FORGET_GLASSES_BLUETOOTH_ERROR ? {error, deviceModel, deviceName} : {error, deviceModel},
      )
    },
    [deviceModel, deviceName, replace],
  )

  useEffect(() => {
    const unsub = engine.pairing.onPairFailure((event: PairFailureEvent) => {
      handlePairFailure(event.error)
    })
    return () => {
      unsub()
    }
  }, [handlePairFailure])

  useEffect(() => {
    if (!isFocused || !selectedDevice || pairingKickoffStartedRef.current) return

    const timer = setTimeout(() => {
      pairingKickoffTimerRef.current = null
      if (pairingStoppedRef.current) return
      pairingKickoffStartedRef.current = true
      console.log(
        `PAIRFLOW: loading_kickoff model=${deviceModel} name=${deviceName ?? ""} secure=${String(
          securePairingRequired,
        )}`,
      )
      logPairingTiming("pairing_kickoff")
      void engine.pairing
        .pair(selectedDevice)
        .then(() => {
          console.log(`PAIRFLOW: loading_kickoff result=started name=${deviceName ?? ""}`)
          setPairingKickoffComplete(true)
        })
        .catch((error) => {
          console.log(`PAIRFLOW: loading_kickoff result=failed name=${deviceName ?? ""} error=${String(error)}`)
          console.error("Failed to connect to selected device:", error)
          if (pairingStoppedRef.current || hasNavigatedRef.current) return
          handlePairFailure("errors:pairingCouldNotStart")
        })
    }, PAIRING_KICKOFF_DELAY_MS)
    pairingKickoffTimerRef.current = timer

    return () => {
      clearTimeout(timer)
      if (pairingKickoffTimerRef.current === timer) pairingKickoffTimerRef.current = null
    }
  }, [handlePairFailure, isFocused, logPairingTiming, selectedDevice])

  useEffect(() => {
    if (!isFocused || !pairingKickoffComplete) return
    const controller = new AbortController()

    void engine.pairing
      .waitForReady({
        deviceModel,
        deviceName,
        timeoutMs: 35_000,
        route: "/pairing/loading",
        signal: controller.signal,
      })
      .then((ready) => {
        if (ready || controller.signal.aborted || pairingStoppedRef.current || hasNavigatedRef.current) return
        handlePairFailure("errors:pairingCouldNotStart")
      })

    return () => {
      controller.abort()
    }
  }, [deviceModel, deviceName, handlePairFailure, isFocused, pairingKickoffComplete])

  useEffect(() => {
    if (
      !isFocused ||
      pairingStoppedRef.current ||
      !pairingKickoffComplete ||
      !securePairingRequired ||
      !selectedTargetReady ||
      pairingInfoReceived
    ) {
      return
    }
    const timer = setTimeout(() => {
      hasNavigatedRef.current = true
      logPairingTiming("pairing_info_timeout", `securePairingCapable=${String(advertisedSecurePairing)}`)
      handlePairFailure("errors:pairingCouldNotStart")
    }, PAIRING_INFO_WAIT_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [
    securePairingRequired,
    isFocused,
    pairingKickoffComplete,
    advertisedSecurePairing,
    selectedTargetReady,
    pairingInfoReceived,
    handlePairFailure,
    logPairingTiming,
  ])

  useEffect(() => {
    if (pairingStoppedRef.current || !isFocused || !pairingKickoffComplete || !selectedTargetReady) {
      return
    }
    logPairingTiming(
      "glasses_fully_booted",
      `pairingInfoReceived=${pairingInfoReceived} securePairingCapable=${String(advertisedSecurePairing)}`,
    )
    if (hasNavigatedRef.current) {
      return
    }

    if (securePairingRequired && !pairingInfoReceived) {
      logPairingTiming("waiting_secure_pairing_info")
      return
    }

    if (
      classicWaitState({
        platform: Platform.OS,
        deviceModel,
        bluetoothClassicConnected,
        bluetoothClassicProfilesConnected,
        bluetoothAudioRouted,
        settleElapsed: classicSettleElapsed,
      }) !== "done"
    ) {
      if (classicAudioRoutedRef.current) return
      if (classicSettleTimerRef.current) return
      logPairingTiming("waiting_ios_classic")
      classicSettleTimerRef.current = setTimeout(() => {
        classicSettleTimerRef.current = null
        if (pairingStoppedRef.current || hasNavigatedRef.current || classicAudioRoutedRef.current) return
        classicAudioRoutedRef.current = true
        setClassicSettleElapsed(true)
        console.log(
          `PAIRFLOW: loading_navigate route=${BT_CLASSIC_ROUTE} model=${deviceModel} name=${deviceName ?? ""}`,
        )
        logPairingTiming("navigate_btclassic")
        useNavigationStore.getState().push(BT_CLASSIC_ROUTE, {device: deviceJson})
      }, IOS_CLASSIC_SETTLE_MS)
      return
    }

    if (classicSettleTimerRef.current) {
      clearTimeout(classicSettleTimerRef.current)
      classicSettleTimerRef.current = null
    }

    hasNavigatedRef.current = true
    console.log(
      `PAIRFLOW: loading_navigate route=/pairing/success model=${deviceModel} name=${
        deviceName ?? ""
      } pairingInfo=${pairingInfoReceived}`,
    )
    logPairingTiming("navigate_success_scheduled")
    navigationTimerRef.current = setTimeout(() => {
      navigationTimerRef.current = null
      replace("/pairing/success", {deviceModel: deviceModel, ar99ProjectName})
    }, 1000)
  }, [
    selectedTargetReady,
    isFocused,
    pairingKickoffComplete,
    replace,
    deviceModel,
    securePairingRequired,
    pairingInfoReceived,
    ar99ProjectName,
    deviceName,
    advertisedSecurePairing,
    logPairingTiming,
    bluetoothClassicConnected,
    bluetoothClassicProfilesConnected,
    bluetoothAudioRouted,
    classicSettleElapsed,
    deviceJson,
  ])

  useEffect(() => {
    if (!isFocused && navigationTimerRef.current) {
      clearTimeout(navigationTimerRef.current)
      navigationTimerRef.current = null
      hasNavigatedRef.current = false
    }
    if (!isFocused && classicSettleTimerRef.current) {
      clearTimeout(classicSettleTimerRef.current)
      classicSettleTimerRef.current = null
    }
  }, [isFocused])

  useEffect(() => {
    return () => {
      if (navigationTimerRef.current) {
        clearTimeout(navigationTimerRef.current)
      }
      if (classicSettleTimerRef.current) {
        clearTimeout(classicSettleTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    console.log(
      `PAIRFLOW: loading_state focused=${isFocused} kickoffComplete=${pairingKickoffComplete} targetReady=${selectedTargetReady} pairingInfo=${pairingInfoReceived} secureRequired=${securePairingRequired} booting=${showGlassesBooting} model=${deviceModel} name=${
        deviceName ?? ""
      }`,
    )
  }, [
    deviceModel,
    deviceName,
    isFocused,
    pairingInfoReceived,
    pairingKickoffComplete,
    securePairingRequired,
    selectedTargetReady,
    showGlassesBooting,
  ])

  focusEffectPreventBack()

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header leftIcon="chevron-left" onLeftPress={handleGoBack} />
      <View className="flex-1">
        <View className="flex-1 justify-center">
          <GlassesPairingLoader
            deviceModel={deviceModel}
            deviceName={deviceName}
            ar99ProjectName={ar99ProjectName}
            isBooting={showGlassesBooting}
            onCancel={handleGoBack}
          />
        </View>
        <Button
          preset="secondary"
          tx="pairing:needMoreHelp"
          onPress={() => setShowTroubleshootingModal(true)}
          className="w-full"
        />
      </View>
      <GlassesTroubleshootingModal
        isVisible={showTroubleshootingModal}
        onClose={() => setShowTroubleshootingModal(false)}
        deviceModel={deviceModel}
      />
    </Screen>
  )
}
