import {useRoute} from "@react-navigation/native"
import BluetoothSdk, {type PairingInfoEvent} from "@mentra/bluetooth-sdk"
import {engine} from "@mentra/engine"
import type {PairFailureEvent} from "@mentra/engine"
import {useCallback, useEffect, useRef, useState} from "react"
import {View} from "react-native"

import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {Button} from "@/components/ignite"
import {Header} from "@/components/ignite/Header"
import {Screen} from "@/components/ignite/Screen"
import GlassesPairingLoader from "@/components/glasses/GlassesPairingLoader"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"

// Secure pairing info should arrive immediately after Mentra Live finishes booting.
// Secure or unknown firmware fails closed instead of spinning forever.
const PAIRING_INFO_WAIT_MS = 5_000

/**
 * Design A (open reclaim): five-tap clears prior owner/bonds on the glasses; the first
 * successful pair wins. Mentra Live pairing does NOT run ownership-transfer finalize/wipe.
 * pairing_info is used only as a secure-firmware readiness signal; the advertised capability
 * lets existing customer firmware proceed without waiting for an event it does not emit.
 */
export default function GlassesPairingLoadingScreen() {
  const {replace, goBack} = useNavigationStore.getState()
  const route = useRoute()
  const {deviceModel, deviceName, ar99ProjectName, securePairingCapable} = route.params as {
    deviceModel: string
    deviceName?: string
    ar99ProjectName?: string
    /** Known upfront from the scan result's advertised capability, before any pairing_info event. */
    securePairingCapable?: boolean
  }
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const hasNavigatedRef = useRef(false)
  const navigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const glassesFullyBooted = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  ).fullyBooted
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)
  const [pairingInfoReceived, setPairingInfoReceived] = useState(false)
  const isMentraLive = deviceModel === DeviceTypes.LIVE
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
    const unsub = engine.pairing.onGlassesNotReady(() => {
      setShowGlassesBooting(true)
      logPairingTiming("glasses_not_ready_ui")
    })
    return () => {
      unsub()
    }
  }, [logPairingTiming])

  useEffect(() => {
    if (!isMentraLive || securePairingCapable === false) {
      return
    }

    const sub = BluetoothSdk.addListener("pairing_info", (event: PairingInfoEvent) => {
      setPairingInfoReceived(true)
      logPairingTiming(
        "pairing_info",
        `had_previous_bond=${event.had_previous_bond} secure=${event.secure_pairing_capable} design=A_open_reclaim`,
      )
    })

    return () => {
      sub.remove()
    }
  }, [isMentraLive, securePairingCapable, logPairingTiming])

  const handleGoBack = useCallback(() => {
    goBack()
  }, [goBack])

  const handlePairFailure = useCallback(
    (error: string) => {
      void engine.pairing.abandonAttempt().catch((cleanupError) => {
        console.warn("Pairing failure cleanup failed:", cleanupError)
      })
      if (error === "errors:pairNeedDisconnect") {
        replace("/pairing/unpair-even", {deviceModel: deviceModel})
        return
      }
      replace("/pairing/failure", {error: error, deviceModel: deviceModel})
    },
    [replace, deviceModel],
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
    const controller = new AbortController()

    void engine.pairing.waitForReady({
      deviceModel,
      deviceName,
      timeoutMs: 35_000,
      route: "/pairing/loading",
      signal: controller.signal,
    })

    return () => {
      controller.abort()
    }
  }, [deviceModel, deviceName])

  useEffect(() => {
    if (!isMentraLive || securePairingCapable === false || !glassesFullyBooted || pairingInfoReceived) {
      return
    }
    const timer = setTimeout(() => {
      hasNavigatedRef.current = true
      logPairingTiming("pairing_info_timeout", `securePairingCapable=${String(securePairingCapable)}`)
      handlePairFailure("errors:pairingCouldNotStart")
    }, PAIRING_INFO_WAIT_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [isMentraLive, securePairingCapable, glassesFullyBooted, pairingInfoReceived, handlePairFailure, logPairingTiming])

  useEffect(() => {
    if (!glassesFullyBooted) {
      return
    }
    logPairingTiming(
      "glasses_fully_booted",
      `pairingInfoReceived=${pairingInfoReceived} securePairingCapable=${String(securePairingCapable)}`,
    )
    if (hasNavigatedRef.current) {
      return
    }

    if (isMentraLive && securePairingCapable !== false && !pairingInfoReceived) {
      logPairingTiming("waiting_secure_pairing_info")
      return
    }

    hasNavigatedRef.current = true
    logPairingTiming("navigate_success_scheduled")
    navigationTimerRef.current = setTimeout(() => {
      replace("/pairing/success", {deviceModel: deviceModel, ar99ProjectName})
    }, 1000)
  }, [
    glassesFullyBooted,
    replace,
    deviceModel,
    isMentraLive,
    pairingInfoReceived,
    ar99ProjectName,
    securePairingCapable,
    logPairingTiming,
  ])

  useEffect(() => {
    return () => {
      if (navigationTimerRef.current) {
        clearTimeout(navigationTimerRef.current)
      }
    }
  }, [])

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
