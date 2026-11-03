import {useIsFocused, useRoute} from "@react-navigation/native"
import type {Device} from "@mentra/bluetooth-sdk"
import {ControllerTypes, engine, DeviceTypes} from "@mentra/engine"
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
import {FORGET_IOS_PAIRING_ROUTE, isIosForgetPairingFailure} from "@/utils/pairing/iosStaleBond"
import {BT_CLASSIC_ROUTE} from "@/utils/pairing/pairAudio"

const PAIRING_KICKOFF_DELAY_MS = 2_000

/**
 * Pairing is one 2-minute window on the glasses, and the Mentra App only renders it. Choosing a pair
 * never confirms anything: the SDK sends `pair_select` on its own, and a previous phone stays paired
 * until the new bond commits on the glasses.
 *
 * The Bluetooth SDK decides when the selected glasses are ready (on secure firmware, only after the
 * glasses commit the new bond) and whether audio needs the user (`audioSetup`). This screen renders
 * both: `connected` or `not_applicable` shows success, `needs_user` opens Pair Audio, and
 * `connecting` keeps the spinner while audio comes up on its own.
 *
 * `pair_failure.code === "ios_forget_pairing"` on iPhone opens the "Forget the old pairing" screen.
 */
export default function GlassesPairingLoadingScreen() {
  const {replace, goBack} = useNavigationStore.getState()
  const route = useRoute()
  const {
    device: deviceJson,
    deviceModel,
    deviceName,
    ar99ProjectName,
  } = route.params as {
    device?: string
    deviceModel: string
    deviceName?: string
    ar99ProjectName?: string
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
  const [pairingKickoffComplete, setPairingKickoffComplete] = useState(false)
  const pairingKickoffStartedRef = useRef(false)
  const pairingKickoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pairingStoppedRef = useRef(false)
  const pairAudioHandedOffRef = useRef(false)
  // Pair Audio covers this screen. Success is only decided again once it hands the screen back.
  const pairAudioUnfocusedRef = useRef(false)
  const pairAudioReturnedRef = useRef(false)
  const {audioSetup: glassesAudioSetup} = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  )
  // Audio setup belongs to glasses. A controller target (R1) has nothing to set up.
  const isControllerTarget = (Object.values(ControllerTypes) as string[]).includes(deviceModel)
  const audioSetup = isControllerTarget ? ({state: "not_applicable"} as const) : glassesAudioSetup
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
    (error: string, code?: string) => {
      // A failure that lands during the one-second success delay wins: cancel the pending success.
      // A failure after the success screen was pushed, or after the user left, is ignored.
      const successPending = navigationTimerRef.current !== null
      if (pairingStoppedRef.current || (hasNavigatedRef.current && !successPending)) return
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
      // iPhone holds a stale Bluetooth pairing for these glasses: the user removes it in Settings.
      // Only this screen names the glasses, with the code.
      if (isIosForgetPairingFailure({code}, Platform.OS)) {
        replace(FORGET_IOS_PAIRING_ROUTE, {deviceModel, deviceName})
        return
      }
      replace("/pairing/failure", {error, deviceModel})
    },
    [deviceModel, deviceName, replace],
  )

  useEffect(() => {
    const unsub = engine.pairing.onPairFailure((event: PairFailureEvent) => {
      handlePairFailure(event.error, event.code)
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
      console.log(`PAIRFLOW: loading_kickoff model=${deviceModel} name=${deviceName ?? ""}`)
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

  const openPairAudio = useCallback(() => {
    if (pairAudioHandedOffRef.current) return
    pairAudioHandedOffRef.current = true
    console.log(`PAIRFLOW: loading_navigate route=${BT_CLASSIC_ROUTE} model=${deviceModel} name=${deviceName ?? ""}`)
    logPairingTiming("navigate_btclassic")
    useNavigationStore.getState().push(BT_CLASSIC_ROUTE, {device: deviceJson})
  }, [deviceJson, deviceModel, deviceName, logPairingTiming])

  useEffect(() => {
    if (!pairAudioHandedOffRef.current) return
    if (!isFocused) pairAudioUnfocusedRef.current = true
    else if (pairAudioUnfocusedRef.current) pairAudioReturnedRef.current = true
  }, [isFocused])

  useEffect(() => {
    if (pairingStoppedRef.current || !isFocused || !pairingKickoffComplete || !selectedTargetReady) {
      return
    }
    logPairingTiming("glasses_fully_booted", `audioSetup=${audioSetup.state}`)
    if (hasNavigatedRef.current) {
      return
    }

    if (audioSetup.state === "needs_user") {
      // Pair Audio advances by itself once the SDK reports audio connected, then hands this screen back.
      openPairAudio()
      return
    }
    if (audioSetup.state !== "connected" && audioSetup.state !== "not_applicable") {
      // `connecting`: the SDK still expects audio to come up on its own and decides when to stop waiting.
      logPairingTiming("waiting_audio_setup", `audioSetup=${audioSetup.state}`)
      return
    }

    // Audio came up after Pair Audio opened: that screen advances itself and gives this one back.
    // Navigating here too would be a second navigation.
    if (pairAudioHandedOffRef.current && !pairAudioReturnedRef.current) return

    hasNavigatedRef.current = true
    console.log(
      `PAIRFLOW: loading_navigate route=/pairing/success model=${deviceModel} name=${
        deviceName ?? ""
      } audioSetup=${audioSetup.state}`,
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
    ar99ProjectName,
    deviceName,
    logPairingTiming,
    audioSetup.state,
    openPairAudio,
  ])

  useEffect(() => {
    if (!isFocused && navigationTimerRef.current) {
      clearTimeout(navigationTimerRef.current)
      navigationTimerRef.current = null
      hasNavigatedRef.current = false
    }
  }, [isFocused])

  useEffect(() => {
    return () => {
      if (navigationTimerRef.current) {
        clearTimeout(navigationTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    console.log(
      `PAIRFLOW: loading_state focused=${isFocused} kickoffComplete=${pairingKickoffComplete} targetReady=${selectedTargetReady} audioSetup=${audioSetup.state} booting=${showGlassesBooting} model=${deviceModel} name=${
        deviceName ?? ""
      }`,
    )
  }, [
    deviceModel,
    deviceName,
    isFocused,
    audioSetup.state,
    pairingKickoffComplete,
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
