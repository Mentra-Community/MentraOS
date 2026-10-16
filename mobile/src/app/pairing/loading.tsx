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
import {FORGET_IOS_PAIRING_ROUTE, isIosForgetPairingFailure} from "@/utils/pairing/iosStaleBond"
import {AUTO_AUDIO_WAIT_MS, BT_CLASSIC_ROUTE, decidePairAudio} from "@/utils/pairing/pairAudio"
import {advertisedSecurePairingCapable, isMentraLiveSecurePairingEnabled} from "@/utils/pairing/securePairingFeature"

// Secure pairing info should arrive immediately after Mentra Live finishes booting.
// Secure or unknown firmware fails closed instead of spinning forever.
const PAIRING_INFO_WAIT_MS = 5_000
const PAIRING_KICKOFF_DELAY_MS = 2_000

/**
 * Pairing is one 2-minute window on the glasses, and the Mentra App only renders it. Choosing a pair
 * never confirms anything: the SDK sends `pair_select` on its own, and a previous phone stays paired
 * until the new bond commits on the glasses.
 *
 * `pairing_info` is a secure-firmware readiness signal and carries `auto_audio`. The advertised
 * capability lets existing customer firmware proceed without waiting for an event it does not emit.
 * Route params arrive as strings, so legacy firmware is both boolean false and "false".
 *
 * iPhone audio (spec S6): always read the real audio state first. Audio up goes straight to success.
 * Audio down with `auto_audio` waits up to 30 s, re-checks, then opens Pair Audio only if it is
 * still down. Audio down without `auto_audio` opens Pair Audio at once. Android never shows it.
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
  const pairAudioHandedOffRef = useRef(false)
  // Pair Audio covers this screen. Success is only decided again once it hands the screen back.
  const pairAudioUnfocusedRef = useRef(false)
  const pairAudioReturnedRef = useRef(false)
  const autoAudioTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [autoAudio, setAutoAudio] = useState<boolean | undefined>(undefined)
  const readiness = useEngineSnapshot(engine.pairing.readiness, (onChange) => engine.pairing.onReadiness(onChange))
  const {bluetoothClassicConnected, bluetoothClassicProfilesConnected, bluetoothAudioRouted} = readiness
  const [autoAudioWaitElapsed, setAutoAudioWaitElapsed] = useState(false)
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
      setAutoAudio(event.auto_audio === true ? true : undefined)
      logPairingTiming(
        "pairing_info",
        `had_previous_bond=${event.had_previous_bond} secure=${event.secure_pairing_capable} auto_audio=${String(
          event.auto_audio,
        )}`,
      )
    })

    return () => {
      sub.remove()
    }
  }, [securePairingRequired, pairingCode, logPairingTiming])

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
      if (autoAudioTimerRef.current) {
        clearTimeout(autoAudioTimerRef.current)
        autoAudioTimerRef.current = null
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
    // A missing pairing_info only leaves the spinner: it never routes to failure and never marks the
    // flow as navigated, so a late pairing_info still lets pairing finish.
    const timer = setTimeout(() => {
      logPairingTiming("pairing_info_timeout", `securePairingCapable=${String(advertisedSecurePairing)}`)
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
    logPairingTiming,
  ])

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

    const audioDecision = decidePairAudio({
      platform: Platform.OS,
      deviceModel,
      readiness: {bluetoothClassicConnected, bluetoothClassicProfilesConnected, bluetoothAudioRouted},
      autoAudio,
      waitElapsed: autoAudioWaitElapsed,
    })

    if (audioDecision !== "done") {
      // Pair Audio already took over once; it advances on its own when audio connects.
      if (pairAudioHandedOffRef.current) return
      if (audioDecision === "pair_audio") {
        openPairAudio()
        return
      }
      if (autoAudioTimerRef.current) return
      logPairingTiming("waiting_auto_audio")
      autoAudioTimerRef.current = setTimeout(() => {
        autoAudioTimerRef.current = null
        if (pairingStoppedRef.current || hasNavigatedRef.current || pairAudioHandedOffRef.current) return
        // Re-check the real audio state at expiry. A connection that lands just before this fires
        // takes the success path below; one that lands just after finds Pair Audio already open.
        const latest = engine.pairing.readiness()
        const atExpiry = decidePairAudio({
          platform: Platform.OS,
          deviceModel,
          readiness: latest,
          autoAudio,
          waitElapsed: true,
        })
        if (atExpiry === "pair_audio") {
          openPairAudio()
          return
        }
        setAutoAudioWaitElapsed(true)
      }, AUTO_AUDIO_WAIT_MS)
      return
    }

    if (autoAudioTimerRef.current) {
      clearTimeout(autoAudioTimerRef.current)
      autoAudioTimerRef.current = null
    }
    // Audio came up after Pair Audio opened: that screen advances itself and gives this one back.
    // Navigating here too would be a second navigation.
    if (pairAudioHandedOffRef.current && !pairAudioReturnedRef.current) return

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
    autoAudio,
    autoAudioWaitElapsed,
    openPairAudio,
  ])

  useEffect(() => {
    if (!isFocused && navigationTimerRef.current) {
      clearTimeout(navigationTimerRef.current)
      navigationTimerRef.current = null
      hasNavigatedRef.current = false
    }
    if (!isFocused && autoAudioTimerRef.current) {
      clearTimeout(autoAudioTimerRef.current)
      autoAudioTimerRef.current = null
    }
  }, [isFocused])

  useEffect(() => {
    return () => {
      if (navigationTimerRef.current) {
        clearTimeout(navigationTimerRef.current)
      }
      if (autoAudioTimerRef.current) {
        clearTimeout(autoAudioTimerRef.current)
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
