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
import {translate} from "@/i18n"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"

// Legacy ads without secure_pairing_capable use this timeout. Secure firmware must not.
const PAIRING_INFO_FALLBACK_MS = 5_000

export default function GlassesPairingLoadingScreen() {
  const {replace, goBack} = useNavigationStore.getState()
  const route = useRoute()
  const {deviceModel, deviceName, ar99ProjectName} = route.params as {
    deviceModel: string
    deviceName?: string
    ar99ProjectName?: string
  }
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const hasNavigatedRef = useRef(false)
  const navigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const glassesFullyBooted = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  ).fullyBooted
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)
  const pairingInfoRef = useRef<PairingInfoEvent | null>(null)
  const [pairingResolved, setPairingResolved] = useState(false)
  const [pairingInfoReceived, setPairingInfoReceived] = useState(false)
  const [pairingInfoTimedOut, setPairingInfoTimedOut] = useState(false)
  const wipePromptShownRef = useRef(false)
  const ownershipInFlightRef = useRef(false)
  const tearedDownRef = useRef(false)
  const isMentraLive = deviceModel === DeviceTypes.LIVE

  useEffect(() => {
    const unsub = engine.pairing.onGlassesNotReady(() => {
      setShowGlassesBooting(true)
    })
    return () => {
      unsub()
    }
  }, [])

  useEffect(() => {
    if (!isMentraLive) {
      return
    }

    const sub = BluetoothSdk.addListener("pairing_info", (event: PairingInfoEvent) => {
      if (tearedDownRef.current) return
      pairingInfoRef.current = event
      setPairingInfoReceived(true)
      if (!event.had_previous_bond) {
        setPairingResolved(true)
      }
    })

    return () => {
      sub.remove()
    }
  }, [isMentraLive])

  const abortPairingTransfer = useCallback(async () => {
    if (tearedDownRef.current) return
    tearedDownRef.current = true
    try {
      await BluetoothSdk.abortPairingTransfer()
    } catch (error) {
      console.error("Failed to abort pairing transfer:", error)
    }
    try {
      await BluetoothSdk.disconnect()
      await BluetoothSdk.forget()
    } catch (error) {
      console.warn("Failed to disconnect/forget after abort:", error)
    }
    replace("/pairing/prep", {deviceModel})
    showAlert(translate("pairing:pairingCancelledTitle"), translate("pairing:pairingCancelledMessage"), [
      {text: translate("common:ok")},
    ])
  }, [deviceModel, replace])

  const handleGoBack = useCallback(() => {
    if (isMentraLive && pairingInfoRef.current?.had_previous_bond === true && !pairingResolved) {
      void abortPairingTransfer()
      return
    }
    goBack()
  }, [goBack, isMentraLive, pairingResolved, abortPairingTransfer])

  const confirmMediaWipe = useCallback(async () => {
    try {
      const result = await BluetoothSdk.wipeMediaForPairing()
      if (!result.success) {
        throw new Error(result.error || "wipe_media_failed")
      }
      // Await classic readiness when BES reported required bond present; do not deadlock
      // if classic was never requested (plan anti-deadlock rule).
      const info = pairingInfoRef.current
      if (info?.classic_bond_ready === false && info?.secure_pairing_capable) {
        await engine.pairing.waitForBluetoothClassic({timeoutMs: 8_000}).catch(() => false)
      }
      const finalize = await BluetoothSdk.finalizePairingTransfer()
      if (!finalize.success) {
        throw new Error(finalize.error || "finalize_failed")
      }
      setPairingResolved(true)
    } catch (error) {
      console.error("Failed to wipe media during pairing:", error)
      wipePromptShownRef.current = false
      showAlert(translate("pairing:wipeMediaTitle"), translate("pairing:wipeMediaMessage"), [
        {
          text: translate("common:cancel"),
          style: "destructive",
          onPress: () => {
            void abortPairingTransfer()
          },
        },
        {
          text: translate("pairing:tryAgain"),
          onPress: () => {
            void confirmMediaWipe()
          },
        },
      ])
    }
  }, [abortPairingTransfer])

  const promptMediaWipe = useCallback(() => {
    if (wipePromptShownRef.current || tearedDownRef.current) {
      return
    }
    wipePromptShownRef.current = true

    showAlert(translate("pairing:wipeMediaTitle"), translate("pairing:wipeMediaMessage"), [
      {
        text: translate("common:cancel"),
        style: "destructive",
        onPress: () => {
          void abortPairingTransfer()
        },
      },
      {
        text: translate("pairing:wipeMediaConfirm"),
        onPress: () => {
          void confirmMediaWipe()
        },
      },
    ])
  }, [abortPairingTransfer, confirmMediaWipe])

  const handleOwnershipTransfer = useCallback(async () => {
    if (ownershipInFlightRef.current || tearedDownRef.current) {
      return
    }
    ownershipInFlightRef.current = true
    try {
      // Always require confirmation when had_previous_bond — even if gallery is empty.
      promptMediaWipe()
    } finally {
      ownershipInFlightRef.current = false
    }
  }, [promptMediaWipe])

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
    if (!isMentraLive || !glassesFullyBooted || pairingInfoReceived || pairingInfoTimedOut) {
      return
    }
    // Secure-capable firmware must not use the legacy pairing_info timeout fallback.
    if (pairingInfoRef.current?.secure_pairing_capable) {
      return
    }
    const timer = setTimeout(() => {
      setPairingInfoTimedOut(true)
    }, PAIRING_INFO_FALLBACK_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [isMentraLive, glassesFullyBooted, pairingInfoReceived, pairingInfoTimedOut])

  useEffect(() => {
    if (!isMentraLive || !pairingInfoReceived || pairingInfoRef.current?.had_previous_bond !== true || pairingResolved) {
      return
    }
    if (navigationTimerRef.current) {
      clearTimeout(navigationTimerRef.current)
      navigationTimerRef.current = null
      hasNavigatedRef.current = false
    }
    void handleOwnershipTransfer()
  }, [isMentraLive, pairingInfoReceived, pairingResolved, handleOwnershipTransfer])

  useEffect(() => {
    if (!glassesFullyBooted) {
      return
    }
    if (hasNavigatedRef.current) {
      return
    }

    if (isMentraLive) {
      const secure = pairingInfoRef.current?.secure_pairing_capable === true
      if (!pairingInfoReceived && !pairingInfoTimedOut) {
        return
      }
      if (secure && !pairingInfoReceived) {
        return
      }
      if (pairingInfoReceived && pairingInfoRef.current?.had_previous_bond === true && !pairingResolved) {
        return
      }
    }

    hasNavigatedRef.current = true
    navigationTimerRef.current = setTimeout(() => {
      replace("/pairing/success", {deviceModel: deviceModel, ar99ProjectName})
    }, 1000)
  }, [
    glassesFullyBooted,
    replace,
    deviceModel,
    isMentraLive,
    pairingInfoReceived,
    pairingInfoTimedOut,
    pairingResolved,
    ar99ProjectName,
  ])

  useEffect(() => {
    return () => {
      if (navigationTimerRef.current) {
        clearTimeout(navigationTimerRef.current)
      }
      // Best-effort abort on controlled unmount during active transfer.
      if (
        isMentraLive &&
        pairingInfoRef.current?.had_previous_bond === true &&
        !pairingResolved &&
        !tearedDownRef.current
      ) {
        tearedDownRef.current = true
        void BluetoothSdk.abortPairingTransfer().catch(() => undefined)
      }
    }
  }, [isMentraLive, pairingResolved])

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
