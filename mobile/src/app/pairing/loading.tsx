import {useIsFocused, useRoute} from "@react-navigation/native"
import BluetoothSdk, {type Device, type PairingInfoEvent} from "@mentra/bluetooth-sdk"
import {engine} from "@mentra/engine"
import type {PairFailureEvent} from "@mentra/engine"
import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {View} from "react-native"

import {DeviceTypes} from "@mentra/engine"
import {Button} from "@/components/ignite"
import {Header} from "@/components/ignite/Header"
import {Screen} from "@/components/ignite/Screen"
import GlassesPairingLoader from "@/components/glasses/GlassesPairingLoader"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"
import {isG2RecoveryError} from "@/utils/pairing/g2Recovery"
import {advertisedSecurePairingCapable, isMentraLiveSecurePairingEnabled} from "@/utils/pairing/securePairingFeature"

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
        `had_previous_bond=${event.had_previous_bond} secure=${event.secure_pairing_capable} design=A_open_reclaim`,
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
    (error: string) => {
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
      replace("/pairing/failure", {error: error, deviceModel: deviceModel})
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
        `PAIRFLOW: loading_kickoff model=${deviceModel} name=${deviceName ?? ""} secure=${String(securePairingRequired)}`,
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

    hasNavigatedRef.current = true
    console.log(
      `PAIRFLOW: loading_navigate route=/pairing/success model=${deviceModel} name=${deviceName ?? ""} pairingInfo=${pairingInfoReceived}`,
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
      `PAIRFLOW: loading_state focused=${isFocused} kickoffComplete=${pairingKickoffComplete} targetReady=${selectedTargetReady} pairingInfo=${pairingInfoReceived} secureRequired=${securePairingRequired} booting=${showGlassesBooting} model=${deviceModel} name=${deviceName ?? ""}`,
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
